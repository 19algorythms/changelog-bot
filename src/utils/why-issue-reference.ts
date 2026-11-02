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
// See: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
const CLOSING_KEYWORD_PATTERN =
  /(?:\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?))\s*[:：]?\s*(?:(?<repoPrefix>[\w.-]+\/[\w.-]+)?#(?<issueNumber>\d+)|\[#(?<linkIssueNumber>\d+)\]\([^)]+\)|(?<issueUrl>https?:\/\/[^\s)]+\/issues\/(?<urlIssueNumber>\d+)\b))/gi;

const DIRECT_ISSUE_URL_PATTERN =
  /\b(?<issueUrl>https?:\/\/[^\s)]+\/issues\/(?<issueNumber>\d+)\b)/gi;

function parseIssueNumber(rawNumber: string | undefined): number | null {
  if (!rawNumber) return null;
  const parsedNumber = Number.parseInt(rawNumber, 10);
  return isSafeInteger(parsedNumber) && parsedNumber > 0 ? parsedNumber : null;
}

function isCurrentRepositoryIssueUrl(
  issueUrl: string | undefined,
  repository: LinkedIssueRepository,
): boolean {
  if (!issueUrl) return false;
  try {
    const parsedUrl = new URL(issueUrl);
    const expectedHost = repository.host ?? 'github.com';
    if (parsedUrl.hostname.toLowerCase() !== expectedHost.toLowerCase()) {
      return false;
    }
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    return (
      pathSegments[0]?.toLowerCase() === repository.owner.toLowerCase() &&
      pathSegments[1]?.toLowerCase() === repository.repo.toLowerCase() &&
      pathSegments[2]?.toLowerCase() === 'issues' &&
      /^\d+$/.test(pathSegments[3] ?? '')
    );
  } catch {
    return false;
  }
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

  const matchedIssueNumbers = new Set<number>();

  // 1. Scan for closing keyword patterns (e.g. Fixes #123, closes owner/repo#456, resolves URL)
  for (const match of body.matchAll(CLOSING_KEYWORD_PATTERN)) {
    const repoPrefix = match.groups?.repoPrefix;
    if (repoPrefix) {
      const expectedRepoPrefix =
        `${repository.owner}/${repository.repo}`.toLowerCase();
      if (repoPrefix.toLowerCase() !== expectedRepoPrefix) {
        continue;
      }
    }

    const issueUrl = match.groups?.issueUrl;
    if (issueUrl && !isCurrentRepositoryIssueUrl(issueUrl, repository)) {
      continue;
    }

    const rawNumber =
      match.groups?.issueNumber ??
      match.groups?.linkIssueNumber ??
      match.groups?.urlIssueNumber;
    const issueNumber = parseIssueNumber(rawNumber);
    if (issueNumber !== null) {
      matchedIssueNumbers.add(issueNumber);
      if (matchedIssueNumbers.size >= MAX_LINKED_ISSUES_PER_PR) {
        return Array.from(matchedIssueNumbers);
      }
    }
  }

  // 2. Scan for direct current-repository issue URLs in the text
  for (const match of body.matchAll(DIRECT_ISSUE_URL_PATTERN)) {
    const issueUrl = match.groups?.issueUrl;
    if (isCurrentRepositoryIssueUrl(issueUrl, repository)) {
      const issueNumber = parseIssueNumber(match.groups?.issueNumber);
      if (issueNumber !== null) {
        matchedIssueNumbers.add(issueNumber);
        if (matchedIssueNumbers.size >= MAX_LINKED_ISSUES_PER_PR) {
          return Array.from(matchedIssueNumbers);
        }
      }
    }
  }

  return Array.from(matchedIssueNumbers);
}
