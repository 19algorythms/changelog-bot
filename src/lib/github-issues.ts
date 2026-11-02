import { GITHUB_API_BASE_DEFAULT } from '@/constants/github.js';
import { githubGet } from '@/lib/github-client.js';
import {
  GitHubIssueInfoSchema,
  type GitHubIssueInfoParsed,
} from '@/schema/github.js';
import type { IssueDetails, MetadataLookupResult } from '@/types/github.js';
import { classifyGithubError } from '@/utils/github-error.js';
import { isUndefined } from '@/utils/is.js';

async function fetchIssueData(
  owner: string,
  repo: string,
  number: number,
  token: string | undefined,
  apiBase: string,
): Promise<MetadataLookupResult<GitHubIssueInfoParsed>> {
  const endpoint = `${apiBase}/repos/${owner}/${repo}/issues/${number}`;
  try {
    const rawData = await githubGet<unknown>(endpoint, token);
    const parsed = GitHubIssueInfoSchema.safeParse(rawData);
    if (!parsed.success) {
      return classifyGithubError(parsed.error, `Issue #${number}`);
    }
    // WHY: In GitHub REST API, GET /repos/{owner}/{repo}/issues/{number} returns
    // both issues and pull requests. When the payload contains `pull_request`, it
    // is a pull request, not a standalone issue. We report not-found to skip it.
    if (!isUndefined(parsed.data.pull_request)) {
      return {
        status: 'not-found',
        message: `Issue #${number} is a pull request, not an issue`,
        statusCode: 404,
      };
    }
    return {
      status: 'success',
      data: parsed.data,
    };
  } catch (caughtError) {
    return classifyGithubError(caughtError, `Issue #${number}`);
  }
}

/**
 * Fetch issue title, body, author, and URL by issue number.
 * @param owner Repository owner or org.
 * @param repo Repository name.
 * @param number Issue number.
 * @param token Optional GitHub token.
 * @param apiBase GitHub API base URL.
 * @returns Lookup result with normalized issue details on success, or structured failure.
 */
export async function fetchIssueDetails(
  owner: string,
  repo: string,
  number: number,
  token?: string,
  apiBase: string = GITHUB_API_BASE_DEFAULT,
): Promise<MetadataLookupResult<IssueDetails>> {
  const result = await fetchIssueData(owner, repo, number, token, apiBase);
  if (result.status !== 'success') {
    return result;
  }
  const issue = result.data;
  return {
    status: 'success',
    data: {
      number: issue.number ?? number,
      title: issue.title ?? '',
      body: issue.body ?? '',
      author: issue.user?.login,
      url: issue.html_url,
    },
  };
}
