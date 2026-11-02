import { describe, expect, test } from '@jest/globals';
import type { IssueDetails, PullRequestDetails } from '@/types/github.js';
import type { WhyTarget } from '@/types/why.js';
import {
  preprocessWhyPrBody,
  sanitizeIssueBody,
} from '@/utils/why-preprocess.js';

const target: WhyTarget = {
  prNumber: 42,
  itemText: 'Fix memory leak in XML parser',
  sectionTitle: 'Fixed',
  author: 'alice',
};

function details(overrides: Partial<PullRequestDetails>): PullRequestDetails {
  return {
    number: 42,
    title: 'Fix memory leak in XML parser',
    body: '',
    author: 'alice',
    url: 'https://github.com/octo/repo/pull/42',
    ...overrides,
  };
}

describe('why-preprocess with linked issues', () => {
  test('extracts trusted WHY candidate from linked issue when PR body is minimal', () => {
    const linkedIssue: IssueDetails = {
      number: 236,
      title: 'Memory leak in XML parser during large document processing',
      body: [
        '### Problem',
        'Large XML documents consume all available heap because parsed node references are retained in the cache.',
        '',
        '### Motivation',
        'To prevent out-of-memory crashes in long-running CI jobs.',
      ].join('\n'),
      author: 'bob',
      url: 'https://github.com/octo/repo/issues/236',
    };

    const result = preprocessWhyPrBody(
      target,
      details({
        body: 'Fixes #236',
      }),
      { maxCharsPerPr: 800 },
      [linkedIssue],
    );

    expect(result.item).toBeDefined();
    expect(result.item?.trustScore).toBeGreaterThanOrEqual(7);
    expect(result.item?.candidates.join('\n')).toContain(
      'Large XML documents consume all available heap',
    );
    expect(result.item?.candidates.join('\n')).toContain(
      'Issue #236: Memory leak in XML parser',
    );
  });

  test('sanitizeIssueBody strips large code blocks and logs while keeping explanation', () => {
    const issueWithLog = [
      '### Problem',
      'The CLI exits with an unhandled exception when parsing config.',
      '',
      '```',
      'Error: Cannot read properties of undefined',
      '    at parseConfig (/app/dist/config.js:42:15)',
      '    at run (/app/dist/cli.js:10:5)',
      '    at main (/app/dist/main.js:1:1)',
      '```',
      '',
      '### Reason',
      'Because the fallback config object was omitted during initialization.',
    ].join('\n');

    const sanitized = sanitizeIssueBody(issueWithLog);
    expect(sanitized).not.toContain('at parseConfig');
    expect(sanitized).toContain('The CLI exits with an unhandled exception');
    expect(sanitized).toContain(
      'Because the fallback config object was omitted',
    );
  });

  test('skips with low trust when linked issue contains no usable problem or rationale', () => {
    const emptyIssue: IssueDetails = {
      number: 999,
      title: 'Update readme',
      body: '<!-- empty template -->\nN/A',
      author: 'alice',
      url: 'https://github.com/octo/repo/issues/999',
    };

    const result = preprocessWhyPrBody(
      target,
      details({
        body: 'Fixes #999',
      }),
      { maxCharsPerPr: 800 },
      [emptyIssue],
    );

    expect(result.item).toBeUndefined();
    expect(result.lowTrust).toBe(true);
    expect(result.skippedReason).toBeDefined();
  });
});
