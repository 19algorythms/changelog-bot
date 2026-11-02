import { describe, expect, test } from '@jest/globals';
import {
  extractLinkedIssueNumbers,
  MAX_LINKED_ISSUES_PER_PR,
} from '@/utils/why-issue-reference.js';

const repository = {
  owner: 'necoz-oss',
  repo: 'changelog-bot',
};

describe('why-issue-reference', () => {
  test('returns empty array when body is empty', () => {
    expect(extractLinkedIssueNumbers('', repository)).toEqual([]);
  });

  test('extracts issue numbers following closing keywords', () => {
    expect(extractLinkedIssueNumbers('Fixes #101', repository)).toEqual([101]);
    expect(extractLinkedIssueNumbers('fixes: #102', repository)).toEqual([102]);
    expect(extractLinkedIssueNumbers('Closes #103', repository)).toEqual([103]);
    expect(extractLinkedIssueNumbers('closed #104', repository)).toEqual([104]);
    expect(extractLinkedIssueNumbers('Resolves #105', repository)).toEqual([
      105,
    ]);
    expect(extractLinkedIssueNumbers('resolved: #106', repository)).toEqual([
      106,
    ]);
  });

  test('extracts issue number from markdown link with closing keyword', () => {
    const body =
      'Fixes [#201](https://github.com/necoz-oss/changelog-bot/issues/201)';
    expect(extractLinkedIssueNumbers(body, repository)).toEqual([201]);
  });

  test('extracts issue number when matching full repo reference', () => {
    const body = 'Closes necoz-oss/changelog-bot#202';
    expect(extractLinkedIssueNumbers(body, repository)).toEqual([202]);
  });

  test('ignores issue references for external repositories', () => {
    const body = 'Fixes other-org/other-repo#999 and closes #301';
    expect(extractLinkedIssueNumbers(body, repository)).toEqual([301]);
  });

  test('extracts direct issue URLs matching the target repository', () => {
    const body = [
      'See problem description at:',
      'https://github.com/necoz-oss/changelog-bot/issues/401',
    ].join('\n');
    expect(extractLinkedIssueNumbers(body, repository)).toEqual([401]);
  });

  test('ignores direct issue URLs for other repositories or pull requests', () => {
    const body = [
      'Related discussion:',
      'https://github.com/facebook/react/issues/501',
      'https://github.com/necoz-oss/changelog-bot/pull/502',
      'Resolves #503',
    ].join('\n');
    expect(extractLinkedIssueNumbers(body, repository)).toEqual([503]);
  });

  test('deduplicates issue references in the same PR description', () => {
    const body = 'Fixes #601 and also resolves #601, see #601';
    expect(extractLinkedIssueNumbers(body, repository)).toEqual([601]);
  });

  test('bounds extracted issues by MAX_LINKED_ISSUES_PER_PR', () => {
    const body = 'Fixes #701, closes #702, and resolves #703';
    const result = extractLinkedIssueNumbers(body, repository);
    expect(result).toHaveLength(MAX_LINKED_ISSUES_PER_PR);
    expect(result).toEqual([701, 702]);
  });
});
