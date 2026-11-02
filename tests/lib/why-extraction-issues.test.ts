import { describe, expect, jest, test } from '@jest/globals';

import { PROVIDER_OPENAI } from '@/constants/provider.js';
import { runWhyExtraction } from '@/lib/why-extraction.js';
import type { CliOptions } from '@/schema/cli.js';
import type { Provider } from '@/types/provider.js';

type FetchPRDetails = typeof import('@/lib/github.js').fetchPRDetails;
type FetchIssueDetails = typeof import('@/lib/github.js').fetchIssueDetails;

const cli: CliOptions = {
  repoPath: '.',
  changelogPath: 'CHANGELOG.md',
  baseBranch: 'main',
  provider: PROVIDER_OPENAI,
  releaseBody: '',
  language: 'en',
  dryRun: false,
  dryRunJsonReport: false,
  failOnLlmError: false,
  requireProvider: false,
  noAi: false,
  why: true,
  whyEngine: 'llm',
  whyMaxPrs: 30,
  whyMaxCharsPerPr: 800,
  whyConfidence: 'medium',
  whyLabel: 'Why',
};

function createMockProvider(): Provider {
  return {
    name: PROVIDER_OPENAI,
    modelName: 'mock',
    supports: {
      jsonMode: true,
      streaming: false,
      reasoning: false,
      maxOutputTokens: 1000,
    },
    generate: jest.fn<Provider['generate']>(async () => ({
      new_section_markdown: 'generated section',
      pr_title: 'docs(changelog): 1.2.3',
      pr_body: 'body',
    })),
    classifyChanges: jest.fn<Provider['classifyChanges']>(async () => ({
      assignments: {},
      diagnostics: [],
    })),
    extractWhyNotes: jest.fn<Provider['extractWhyNotes']>(async () => ({
      items: [
        {
          prNumber: 42,
          why: 'Large XML documents caused runaway memory consumption.',
          confidence: 'high' as const,
        },
      ],
    })),
  };
}

describe('runWhyExtraction with linked issues', () => {
  test('fetches linked issue evidence when PR body is minimal and renders WHY note', async () => {
    const selectedProvider = createMockProvider();
    const fetchPRDetails = jest.fn<FetchPRDetails>(async () => ({
      status: 'success',
      data: {
        number: 42,
        title: 'Fix memory leak in XML parser',
        body: 'Resolves #236',
        author: 'alice',
        url: 'https://github.com/octo/repo/pull/42',
      },
    }));

    const fetchIssueDetails = jest.fn<FetchIssueDetails>(async () => ({
      status: 'success',
      data: {
        number: 236,
        title: 'Memory leak in XML parser during large document processing',
        body: [
          '### Problem',
          'Large XML documents cause runaway memory consumption because parsed nodes stay cached.',
          '',
          '### Motivation',
          'To avoid crash in production workloads.',
        ].join('\n'),
        author: 'bob',
        url: 'https://github.com/octo/repo/issues/236',
      },
    }));

    const result = await runWhyExtraction({
      cli,
      llm: {
        new_section_markdown: [
          '### Fixed',
          '',
          '- Fix memory leak in XML parser [#42](https://github.com/octo/repo/pull/42) by @alice',
        ].join('\n'),
        pr_title: 'docs(changelog): 1.2.3',
        pr_body: 'Generated changelog.',
      },
      changelogAiUsed: true,
      provider: selectedProvider,
      hasProviderKey: true,
      owner: 'octo',
      repo: 'repo',
      token: 'test-token',
      githubApiBase: 'https://api.github.com',
      fetchPRDetails,
      fetchIssueDetails,
    });

    expect(fetchPRDetails).toHaveBeenCalledWith(
      'octo',
      'repo',
      42,
      'test-token',
      'https://api.github.com',
    );
    expect(fetchIssueDetails).toHaveBeenCalledWith(
      'octo',
      'repo',
      236,
      'test-token',
      'https://api.github.com',
    );

    // Verify provider received candidates extracted from the linked issue
    expect(selectedProvider.extractWhyNotes).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            prNumber: 42,
            candidates: expect.arrayContaining([
              expect.stringContaining(
                'Large XML documents cause runaway memory consumption',
              ),
            ]),
          }),
        ],
      }),
    );

    expect(result.llm.new_section_markdown).toContain(
      '  - Why: Large XML documents caused runaway memory consumption.',
    );
    expect(result.diagnostics.notesRendered).toBe(1);

    // Verify metadata diagnostics track both the PR and issue lookups
    expect(result.metadataDiagnostics).toEqual(
      expect.objectContaining({
        totalLookups: 2,
        successfulLookups: 2,
        degradedLookups: 0,
      }),
    );
  });

  test('deduplicates issue lookups across multiple PRs referencing the same issue', async () => {
    const selectedProvider = createMockProvider();
    jest.mocked(selectedProvider.extractWhyNotes).mockResolvedValue({
      items: [
        {
          prNumber: 10,
          why: 'Shared issue rationale.',
          confidence: 'high',
        },
        {
          prNumber: 20,
          why: 'Shared issue rationale.',
          confidence: 'high',
        },
      ],
    });

    const fetchPRDetails = jest.fn<FetchPRDetails>(
      async (_owner, _repo, prNumber) => ({
        status: 'success',
        data: {
          number: prNumber,
          title: `PR #${prNumber}`,
          body: 'Closes #100',
          author: 'charlie',
          url: `https://github.com/octo/repo/pull/${prNumber}`,
        },
      }),
    );

    const fetchIssueDetails = jest.fn<FetchIssueDetails>(async () => ({
      status: 'success',
      data: {
        number: 100,
        title: 'Problem description for shared issue',
        body: '### Problem\nShared issue problem statement.',
        author: 'bob',
        url: 'https://github.com/octo/repo/issues/100',
      },
    }));

    const result = await runWhyExtraction({
      cli,
      llm: {
        new_section_markdown: [
          '### Fixed',
          '',
          '- PR ten [#10](https://github.com/octo/repo/pull/10)',
          '- PR twenty [#20](https://github.com/octo/repo/pull/20)',
        ].join('\n'),
        pr_title: 'docs(changelog): 1.2.3',
        pr_body: 'body',
      },
      changelogAiUsed: true,
      provider: selectedProvider,
      hasProviderKey: true,
      owner: 'octo',
      repo: 'repo',
      token: 'test-token',
      githubApiBase: 'https://api.github.com',
      fetchPRDetails,
      fetchIssueDetails,
    });

    // 2 PR lookups, but only 1 issue lookup because issue #100 was deduplicated
    expect(fetchPRDetails).toHaveBeenCalledTimes(2);
    expect(fetchIssueDetails).toHaveBeenCalledTimes(1);
    expect(result.metadataDiagnostics?.totalLookups).toBe(3);
    expect(result.metadataDiagnostics?.successfulLookups).toBe(3);
  });

  test('gracefully degrades when linked issue lookup returns not-found without throwing', async () => {
    const selectedProvider = createMockProvider();
    const fetchPRDetails = jest.fn<FetchPRDetails>(async () => ({
      status: 'success',
      data: {
        number: 55,
        title: 'Fix edge case',
        body: 'Fixes #404',
        author: 'alice',
        url: 'https://github.com/octo/repo/pull/55',
      },
    }));

    const fetchIssueDetails = jest.fn<FetchIssueDetails>(async () => ({
      status: 'not-found',
      message: 'Issue #404 not found (404)',
      statusCode: 404,
    }));

    const result = await runWhyExtraction({
      cli,
      llm: {
        new_section_markdown: [
          '### Fixed',
          '',
          '- Fix edge case [#55](https://github.com/octo/repo/pull/55)',
        ].join('\n'),
        pr_title: 'docs(changelog): 1.2.3',
        pr_body: 'body',
      },
      changelogAiUsed: true,
      provider: selectedProvider,
      hasProviderKey: true,
      owner: 'octo',
      repo: 'repo',
      token: 'test-token',
      githubApiBase: 'https://api.github.com',
      fetchPRDetails,
      fetchIssueDetails,
    });

    // Degraded issue lookup was recorded in metadata diagnostics
    expect(result.metadataDiagnostics?.totalLookups).toBe(2);
    expect(result.metadataDiagnostics?.successfulLookups).toBe(1);
    expect(result.metadataDiagnostics?.degradedLookups).toBe(1);
    expect(result.metadataDiagnostics?.failureCounts['not-found']).toBe(1);
    expect(result.metadataDiagnostics?.fallbackReasons).toContain(
      'Skipped Issue #404: issue not found (404)',
    );
  });
});
