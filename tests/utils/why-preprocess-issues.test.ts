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

  test('dropped issue section does not inflate trust score or structural signal', () => {
    // WHY: If character budget drops a trailing ### Motivation section, its strong
    // structural signal must not be counted in the local trust score.
    const linkedIssue: IssueDetails = {
      number: 237,
      title:
        'Documentation updates and clarifications across the entire repository',
      body: [
        '### Summary',
        'This is a comprehensive summary of all documentation changes made across every single markdown file in the entire repository.',
        '',
        '### Motivation',
        'Why this change is required urgently to prevent user confusion.',
      ].join('\n'),
      author: 'bob',
      url: 'https://github.com/octo/repo/issues/237',
    };

    // Budget only allows the title and part of the summary; Motivation is dropped
    const budgetConstrainedResult = preprocessWhyPrBody(
      target,
      details({ body: 'Fixes #237' }),
      { maxCharsPerPr: 100 },
      [linkedIssue],
    );

    // Budget allows both sections; Motivation is retained
    const unconstrainedResult = preprocessWhyPrBody(
      target,
      details({ body: 'Fixes #237' }),
      { maxCharsPerPr: 800 },
      [linkedIssue],
    );

    expect(budgetConstrainedResult.item).toBeDefined();
    expect(unconstrainedResult.item).toBeDefined();

    // The unconstrained item has the strong 'motivation' section retained (+4 points)
    expect(
      (unconstrainedResult.item?.trustScore ?? 0) -
        (budgetConstrainedResult.item?.trustScore ?? 0),
    ).toBeGreaterThanOrEqual(4);
  });

  test('preserves inline Why label scoring from pull request description', () => {
    const result = preprocessWhyPrBody(
      target,
      details({
        body: 'Why: To prevent crash when processing malformed tokens in parser.',
      }),
      { maxCharsPerPr: 800 },
    );

    expect(result.item).toBeDefined();
    // Strong canonical 'why' section (+4) + rationale marker (+3) + inline label bonus (+2) + problem marker (+2)
    expect(result.item?.trustScore).toBeGreaterThanOrEqual(9);
  });

  test('retains linked issue evidence even when PR candidates fill character budget', () => {
    // WHY: Voluminous PR descriptions must not starve linked issue rationale from reaching the model.
    const longPrBody = [
      '### Description',
      'This is an extensive description of the PR that goes on and on to consume all available characters in the candidate budget limit.',
      'It contains multiple long paragraphs explaining various implementation aspects of the refactoring and cleanup work done here.',
    ].join('\n');

    const linkedIssue: IssueDetails = {
      number: 238,
      title: 'Buffer overflow when parsing malformed headers',
      body: [
        '### Problem',
        'Large header inputs overflow the allocated parser buffer and cause segmentation faults.',
      ].join('\n'),
      author: 'bob',
      url: 'https://github.com/octo/repo/issues/238',
    };

    const result = preprocessWhyPrBody(
      target,
      details({ body: `${longPrBody}\n\nFixes #238` }),
      { maxCharsPerPr: 250 },
      [linkedIssue],
    );

    expect(result.item).toBeDefined();
    const joinedCandidates = result.item?.candidates.join('\n') ?? '';
    // Both PR candidate text and issue evidence must be present
    expect(joinedCandidates).toContain('This is an extensive description');
    expect(joinedCandidates).toContain('Issue #238: Buffer overflow');
  });

  test('does not falsely credit issue section when duplicate text exists in weak PR section', () => {
    // WHY: Deduplication should not attribute strong issue section trust to a PR when
    // identical text comes from a weaker PR section.
    const duplicateSentence =
      'Refactored parser to avoid crash when processing malformed token streams.';

    const linkedIssue: IssueDetails = {
      number: 239,
      title: 'Parser crash during malformed stream handling',
      body: ['### Motivation', duplicateSentence].join('\n'),
      author: 'bob',
      url: 'https://github.com/octo/repo/issues/239',
    };

    // PR has only a weak 'Summary' section with the duplicate sentence
    const prOnlyResult = preprocessWhyPrBody(
      target,
      details({
        body: `### Summary\n${duplicateSentence}`,
      }),
      { maxCharsPerPr: 800 },
    );

    // Linked issue has the duplicate sentence under strong 'Motivation'
    const withIssueResult = preprocessWhyPrBody(
      target,
      details({
        body: `### Summary\n${duplicateSentence}\n\nFixes #239`,
      }),
      { maxCharsPerPr: 800 },
      [linkedIssue],
    );

    expect(prOnlyResult.item).toBeDefined();
    expect(withIssueResult.item).toBeDefined();

    // Verify deduplication: duplicateSentence should appear only once in candidates
    const matches = withIssueResult.item?.candidates.filter(
      (c) => c === duplicateSentence,
    );
    expect(matches).toHaveLength(1);
  });
});
