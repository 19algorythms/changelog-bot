import { isSafeInteger } from '@/utils/is.js';

/** Maximum number of linked issues to resolve per PR to bound network and token overhead. */
export const MAX_LINKED_ISSUES_PER_PR = 2;

/** Repository identity used to validate linked issue references and URLs. */
export type LinkedIssueRepository = {
  /** Repository owner or organization. */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Web hostname used by issue links, default to github.com. */
  host?: string;
};

// WHY: Match GitHub closing keywords preceding an issue reference or URL.
// Handles Markdown links [label](url), direct URLs, or shorthand #123 / owner/repo#123.
// For Markdown links, the target URL is authoritative rather than the anchor label.
// See: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
const CLOSING_KEYWORD_PATTERN =
  /(?:\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?))\s*[:：]?\s*(?:\[[^\]]+\]\((?<markdownUrl>https?:\/\/[^\s)]+)\)|(?<issueUrl>https?:\/\/[^\s)]+\/issues\/(?<urlIssueNumber>\d+)\b)|(?:(?<repoPrefix>[\w.-]+\/[\w.-]+)?#(?<issueNumber>\d+)))/gi;

const DIRECT_ISSUE_URL_PATTERN =
  /\b(?<issueUrl>https?:\/\/[^\s)]+\/issues\/(?<issueNumber>\d+)\b)/gi;

function parseIssueNumber(rawNumber: string | undefined): number | null {
  if (!rawNumber) return null;
  const parsedNumber = Number.parseInt(rawNumber, 10);
  return isSafeInteger(parsedNumber) && parsedNumber > 0 ? parsedNumber : null;
}

function parseIssueNumberFromUrl(
  issueUrl: string | undefined,
  repository: LinkedIssueRepository,
): number | null {
  if (!issueUrl) return null;
  try {
    const parsedUrl = new URL(issueUrl);
    const expectedHost = repository.host ?? 'github.com';
    if (parsedUrl.hostname.toLowerCase() !== expectedHost.toLowerCase()) {
      return null;
    }
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    if (
      pathSegments.length === 4 &&
      pathSegments[0]?.toLowerCase() === repository.owner.toLowerCase() &&
      pathSegments[1]?.toLowerCase() === repository.repo.toLowerCase() &&
      pathSegments[2]?.toLowerCase() === 'issues' &&
      /^\d+$/.test(pathSegments[3] ?? '')
    ) {
      return parseIssueNumber(pathSegments[3]);
    }
    return null;
  } catch {
    return null;
  }
}

// WHY: Exclude HTML comments (such as PR templates e.g. "<!-- Fixes #123 -->")
// and code blocks/spans so non-authoritative references do not consume MAX_LINKED_ISSUES_PER_PR.
function stripIgnoredIssueReferenceMarkup(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/~~~[\s\S]*?~~~/g, '\n')
    .replace(/`[^`\n]*`/g, ' ');
}

/**
 * Extract authoritative linked issue numbers referenced in a PR body.
 * WHY: Closing keywords (e.g. "Fixes #123") and direct issue URLs in the target repo
 * explicitly link changes to user-facing problems without speculative cross-repo noise.
 * @param body Raw or normalized pull request description.
 * @param repository Target repository context.
 * @returns Array of unique issue numbers, capped at MAX_LINKED_ISSUES_PER_PR.
 */
export function extractLinkedIssueNumbers(
  body: string,
  repository: LinkedIssueRepository,
): number[] {
  if (!body) return [];

  const cleanBody = stripIgnoredIssueReferenceMarkup(body);
  const matchedIssueNumbers = new Set<number>();

  // 1. Scan for closing keyword patterns (e.g. Fixes #123, closes owner/repo#456, resolves URL or [label](URL))
  for (const match of cleanBody.matchAll(CLOSING_KEYWORD_PATTERN)) {
    const markdownUrl = match.groups?.markdownUrl;
    if (markdownUrl) {
      const issueNumber = parseIssueNumberFromUrl(markdownUrl, repository);
      if (issueNumber !== null) {
        matchedIssueNumbers.add(issueNumber);
        if (matchedIssueNumbers.size >= MAX_LINKED_ISSUES_PER_PR) {
          return Array.from(matchedIssueNumbers);
        }
      }
      continue;
    }

    const issueUrl = match.groups?.issueUrl;
    if (issueUrl) {
      const issueNumber = parseIssueNumberFromUrl(issueUrl, repository);
      if (issueNumber !== null) {
        matchedIssueNumbers.add(issueNumber);
        if (matchedIssueNumbers.size >= MAX_LINKED_ISSUES_PER_PR) {
          return Array.from(matchedIssueNumbers);
        }
      }
      continue;
    }

    const repoPrefix = match.groups?.repoPrefix;
    if (repoPrefix) {
      const expectedRepoPrefix =
        `${repository.owner}/${repository.repo}`.toLowerCase();
      if (repoPrefix.toLowerCase() !== expectedRepoPrefix) {
        continue;
      }
    }

    const issueNumber = parseIssueNumber(match.groups?.issueNumber);
    if (issueNumber !== null) {
      matchedIssueNumbers.add(issueNumber);
      if (matchedIssueNumbers.size >= MAX_LINKED_ISSUES_PER_PR) {
        return Array.from(matchedIssueNumbers);
      }
    }
  }

  // 2. Scan for direct current-repository issue URLs in the text
  for (const match of cleanBody.matchAll(DIRECT_ISSUE_URL_PATTERN)) {
    const issueUrl = match.groups?.issueUrl;
    const issueNumber = parseIssueNumberFromUrl(issueUrl, repository);
    if (issueNumber !== null) {
      matchedIssueNumbers.add(issueNumber);
      if (matchedIssueNumbers.size >= MAX_LINKED_ISSUES_PER_PR) {
        return Array.from(matchedIssueNumbers);
      }
    }
  }

  return Array.from(matchedIssueNumbers);
}
