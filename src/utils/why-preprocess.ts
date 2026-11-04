import {
  MIN_WHY_CANDIDATE_LINE_LENGTH,
  WHY_MAX_BODY_WITHOUT_TARGET_SECTION,
  WHY_MIN_MODEL_TRUST_SCORE,
  WHY_RAW_BODY_SCAN_LIMIT,
} from '@/constants/why.js';
import type { WhyCanonicalSectionName } from '@/constants/why-section-aliases.js';
import type { IssueDetails, PullRequestDetails } from '@/types/github.js';
import type {
  WhyExtractionItem,
  WhyTarget,
  WhyTrustBucket,
} from '@/types/why.js';
import { isDependencyUpdateTitle } from '@/utils/dependency-update.js';
import {
  buildWhyCandidateSnippets,
  extractWhyTargetSections,
  normalizeWhyBody,
  type ExtractedSection,
} from '@/utils/why-candidates.js';

const STRONG_CANONICAL_SECTION_NAMES = new Set<WhyCanonicalSectionName>([
  'why',
  'reason',
  'because',
  'motivation',
  'context',
  'background',
  'problem',
  'rationale',
]);
const RATIONALE_MARKER_RE =
  /\b(why|because|so that|in order to|reason|rationale|motivation|to avoid|to prevent|context|problem)\b|,\s*so\b/i;
const PROBLEM_MARKER_RE =
  /\b(fix|prevent|avoid|missing|broken|incorrect|regression|failure|bug|issue|risk|support|compatib|performance|leak|crash)\b/i;
const ISSUE_REF_RE =
  /(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#\d+|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/i;
const NON_SIGNAL_RE = /\b(changelog|readme|typo|format|lint|refactor only)\b/i;
const BOT_AUTHOR_RE = /(?:\[bot\]|bot$|renovate|dependabot)/i;

// WHY: Reserve a portion of candidate budget for linked issues so voluminous PR descriptions
// do not starve issue rationale, while still prioritizing explicit PR rationale sections.
const LINKED_ISSUE_RESERVED_RATIO = 0.35;

type PreprocessPrBodyOptions = {
  /** Maximum candidate characters to keep for this PR. */
  maxCharsPerPr: number;
};

type PreprocessPrBodyResult = {
  /** Provider-ready candidate item when local trust is sufficient. */
  item?: WhyExtractionItem;
  /** Skip reason for diagnostics. */
  skippedReason?: string;
  /** Whether the skipped item failed trust thresholds. */
  lowTrust: boolean;
};

type CandidateOrigin =
  | { kind: 'pr'; section?: ExtractedSection; isStrong: boolean }
  | { kind: 'issue-title'; issueNumber: number }
  | {
      kind: 'issue-section';
      issueNumber: number;
      section: ExtractedSection;
      isStrong: boolean;
    }
  | { kind: 'issue-body'; issueNumber: number };

type CandidateEntry = {
  text: string;
  origin: CandidateOrigin;
};

function trustBucketForScore(score: number): WhyTrustBucket {
  if (score >= 9) return 'high';
  if (score >= WHY_MIN_MODEL_TRUST_SCORE) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}

/**
 * Sanitize an issue description by stripping raw stack traces, error dumps, and large code blocks.
 * @param body Raw issue description markdown.
 * @returns Cleaned issue body suitable for rationale section extraction.
 */
export function sanitizeIssueBody(body: string): string {
  // WHY: Issues often contain multi-line stack traces or console dumps inside code fences
  // which pollute token budget without stating the underlying change rationale.
  const withoutLargeCodeFences = body.replace(
    /```[\s\S]*?```/g,
    (codeBlock) => {
      const lineCount = codeBlock.split('\n').length;
      return lineCount > 3 ? '\n' : codeBlock;
    },
  );
  return normalizeWhyBody(withoutLargeCodeFences);
}

function scoreCandidateMaterial(
  sections: ExtractedSection[],
  candidates: string[],
  body: string,
): number {
  const candidateText = candidates.join('\n');
  let score = 0;

  if (
    sections.some((section) => STRONG_CANONICAL_SECTION_NAMES.has(section.name))
  ) {
    score += 4;
  } else if (sections.length > 0) {
    score += 2;
  }
  if (
    sections.some(
      (section) =>
        section.source === 'label-block' &&
        STRONG_CANONICAL_SECTION_NAMES.has(section.name),
    )
  ) {
    score += 2;
  }
  const hasInlineWhyLabel = sections.some(
    (section) => section.name === 'why' && section.source === 'inline-label',
  );
  // WHY: Inline labels are removed from candidate text, so retain their
  // explicit rationale signal for trust scoring.
  const hasRationaleMarker =
    RATIONALE_MARKER_RE.test(candidateText) || hasInlineWhyLabel;
  const hasProblemMarker = PROBLEM_MARKER_RE.test(candidateText);
  if (hasRationaleMarker) score += 3;
  if (hasProblemMarker) score += 2;
  // WHY: Description prose must explicitly signal rationale. An inline Why
  // label is equally explicit even though container extraction removes its
  // Description parent.
  if (
    hasRationaleMarker &&
    (hasInlineWhyLabel ||
      sections.some((section) => section.name === 'description'))
  ) {
    score += 2;
  }
  if (ISSUE_REF_RE.test(body)) score += 1;
  if (candidateText.length >= 60) score += 1;
  if (candidateText.length > 500) score += 1;
  if (containsNonAscii(candidateText) && candidateText.length >= 40) {
    score += 6;
  }
  if (
    NON_SIGNAL_RE.test(candidateText) &&
    !hasRationaleMarker &&
    !hasProblemMarker
  ) {
    score -= 2;
  }

  return Math.max(score, 0);
}

function hasStrongStructuralSignal(sections: ExtractedSection[]): boolean {
  return sections.some((section) =>
    STRONG_CANONICAL_SECTION_NAMES.has(section.name),
  );
}

function containsNonAscii(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) > 127);
}

/**
 * Convert a PR body and optional linked issue material into bounded WHY candidate snippets with local trust.
 * @param target Changelog PR target.
 * @param details Pull request details fetched from GitHub.
 * @param options Preprocessing limits.
 * @param linkedIssues Optional details of linked issues referenced by closing keywords.
 * @returns Provider-ready item or a skip reason.
 */
export function preprocessWhyPrBody(
  target: WhyTarget,
  details: PullRequestDetails,
  options: PreprocessPrBodyOptions,
  linkedIssues?: readonly IssueDetails[],
): PreprocessPrBodyResult {
  const title = target.changeId
    ? target.itemText
    : details.title || target.itemText;
  if (
    isDependencyUpdateTitle(title) ||
    (details.author && BOT_AUTHOR_RE.test(details.author))
  ) {
    return {
      skippedReason: `Skipped PR #${target.prNumber}: automatic maintenance PR`,
      lowTrust: false,
    };
  }

  const rawPrBody = details.body ?? '';
  const body = normalizeWhyBody(rawPrBody).slice(0, WHY_RAW_BODY_SCAN_LIMIT);

  // Collect candidate sections and snippets from linked issues
  const issueEntries: CandidateEntry[] = [];
  if (linkedIssues && linkedIssues.length > 0) {
    for (const linkedIssue of linkedIssues) {
      const sanitizedIssueBody = sanitizeIssueBody(linkedIssue.body).slice(
        0,
        WHY_RAW_BODY_SCAN_LIMIT,
      );
      const cleanIssueTitle = linkedIssue.title.replace(/\s+/g, ' ').trim();
      if (cleanIssueTitle.length >= MIN_WHY_CANDIDATE_LINE_LENGTH) {
        issueEntries.push({
          text: `Issue #${linkedIssue.number}: ${cleanIssueTitle}`,
          origin: { kind: 'issue-title', issueNumber: linkedIssue.number },
        });
      }

      const extractedIssue = extractWhyTargetSections(sanitizedIssueBody);
      if (extractedIssue.sections.length > 0) {
        for (const section of extractedIssue.sections) {
          const isStrong = STRONG_CANONICAL_SECTION_NAMES.has(section.name);
          const snippets = buildWhyCandidateSnippets(
            [section],
            section.text,
            options.maxCharsPerPr,
            false,
          );
          for (const snippet of snippets) {
            issueEntries.push({
              text: snippet,
              origin: {
                kind: 'issue-section',
                issueNumber: linkedIssue.number,
                section,
                isStrong,
              },
            });
          }
        }
      } else if (!extractedIssue.hasTargetSection) {
        const fallbackSnippets = buildWhyCandidateSnippets(
          [],
          sanitizedIssueBody,
          options.maxCharsPerPr,
          true,
        );
        for (const snippet of fallbackSnippets) {
          issueEntries.push({
            text: snippet,
            origin: { kind: 'issue-body', issueNumber: linkedIssue.number },
          });
        }
      }
    }
  }

  if (!body && issueEntries.length === 0) {
    return {
      skippedReason: `Skipped PR #${target.prNumber}: empty PR description`,
      lowTrust: true,
    };
  }

  const extracted = extractWhyTargetSections(body);
  if (
    !extracted.hasTargetSection &&
    body.length > WHY_MAX_BODY_WITHOUT_TARGET_SECTION &&
    issueEntries.length === 0
  ) {
    return {
      skippedReason: `Skipped PR #${target.prNumber}: PR description too large without target section`,
      lowTrust: true,
    };
  }

  const prEntries: CandidateEntry[] = [];
  if (extracted.sections.length > 0) {
    for (const section of extracted.sections) {
      const isStrong = STRONG_CANONICAL_SECTION_NAMES.has(section.name);
      const snippets = buildWhyCandidateSnippets(
        [section],
        section.text,
        options.maxCharsPerPr,
        false,
      );
      for (const snippet of snippets) {
        prEntries.push({
          text: snippet,
          origin: { kind: 'pr', section, isStrong },
        });
      }
    }
  } else if (!extracted.hasTargetSection && body) {
    const fallbackSnippets = buildWhyCandidateSnippets(
      [],
      body,
      options.maxCharsPerPr,
      true,
    );
    for (const snippet of fallbackSnippets) {
      prEntries.push({
        text: snippet,
        origin: { kind: 'pr', isStrong: false },
      });
    }
  }

  // Assemble candidate pool: prioritize explicit rationale and reserve budget for linked issues
  let candidatePool: CandidateEntry[];
  if (issueEntries.length === 0) {
    candidatePool = prEntries;
  } else {
    const prStrongEntries = prEntries.filter(
      (entry) => entry.origin.kind === 'pr' && entry.origin.isStrong,
    );
    const prGeneralEntries = prEntries.filter(
      (entry) => entry.origin.kind === 'pr' && !entry.origin.isStrong,
    );

    // WHY: Bound PR strong candidates to ensure linked issue evidence has reserved space
    const reservedIssueBudget = Math.max(
      Math.floor(options.maxCharsPerPr * LINKED_ISSUE_RESERVED_RATIO),
      MIN_WHY_CANDIDATE_LINE_LENGTH,
    );
    const maxPrStrongBudget = Math.max(
      options.maxCharsPerPr - reservedIssueBudget,
      MIN_WHY_CANDIDATE_LINE_LENGTH,
    );

    const boundedPrStrongEntries: CandidateEntry[] = [];
    let prStrongChars = 0;
    for (const entry of prStrongEntries) {
      if (
        prStrongChars + entry.text.length + 1 > maxPrStrongBudget &&
        boundedPrStrongEntries.length > 0
      ) {
        break;
      }
      boundedPrStrongEntries.push(entry);
      prStrongChars += entry.text.length + 1;
    }

    candidatePool = [
      ...boundedPrStrongEntries,
      ...issueEntries,
      ...prGeneralEntries,
    ];
  }

  if (candidatePool.length === 0) {
    return {
      skippedReason: `Skipped PR #${target.prNumber}: no usable WHY candidate`,
      lowTrust: true,
    };
  }

  // Deduplicate candidate lines while preserving order and source tracking
  const seenCandidates = new Set<string>();
  const uniqueCandidateEntries: CandidateEntry[] = [];
  for (const entry of candidatePool) {
    const trimmed = entry.text.trim();
    if (trimmed && !seenCandidates.has(trimmed)) {
      seenCandidates.add(trimmed);
      uniqueCandidateEntries.push(entry);
    }
  }

  const boundedEntries: Array<{ entry: CandidateEntry; text: string }> = [];
  let usedChars = 0;
  for (const candidateEntry of uniqueCandidateEntries) {
    const availableChars = options.maxCharsPerPr - usedChars;
    if (availableChars <= 0) break;
    if (candidateEntry.text.length <= availableChars) {
      boundedEntries.push({ entry: candidateEntry, text: candidateEntry.text });
      usedChars += candidateEntry.text.length + 1;
    } else {
      const slicedText = candidateEntry.text.slice(0, availableChars);
      if (slicedText.length >= MIN_WHY_CANDIDATE_LINE_LENGTH) {
        boundedEntries.push({ entry: candidateEntry, text: slicedText });
      }
      break;
    }
  }

  const candidates = boundedEntries.map((b) => b.text);

  // WHY: Retain only issue sections that actually contributed usable candidates to the final bounded pool.
  // Using direct origin tracking avoids false attribution from text matching or deduplicated PR candidates,
  // and ensures heavily truncated snippets (< MIN_WHY_CANDIDATE_LINE_LENGTH) do not grant unearned trust credit.
  const effectiveIssueSections = Array.from(
    new Set(
      boundedEntries
        .filter(
          (b) =>
            b.entry.origin.kind === 'issue-section' &&
            b.text.length >= MIN_WHY_CANDIDATE_LINE_LENGTH,
        )
        .map((b) => (b.entry.origin as { section: ExtractedSection }).section),
    ),
  );

  const combinedSections = [...extracted.sections, ...effectiveIssueSections];
  const combinedBodyForScoring = `${body}\n${issueEntries.map((e) => e.text).join('\n')}`;

  const trustScore = scoreCandidateMaterial(
    combinedSections,
    candidates,
    combinedBodyForScoring,
  );
  const trustBucket = trustBucketForScore(trustScore);
  const requiresHighConfidence =
    containsNonAscii(candidates.join('\n')) &&
    !hasStrongStructuralSignal(combinedSections);

  if (trustScore < WHY_MIN_MODEL_TRUST_SCORE) {
    return {
      skippedReason: `Skipped PR #${target.prNumber}: low local trust score (${trustScore})`,
      lowTrust: true,
    };
  }

  return {
    item: {
      prNumber: target.prNumber,
      changeId: target.changeId,
      itemText: target.itemText,
      sectionTitle: target.sectionTitle,
      title,
      candidates,
      trustScore,
      trustBucket,
      requiresHighConfidence,
    },
    lowTrust: false,
  };
}
