const {
  beforeEach,
  describe,
  expect,
  jest: jestGlobal,
  test,
} = await import('@jest/globals');

type GetJsonMock = (
  url: string,
  headers: Record<string, string>,
  errorPrefix: string,
) => Promise<unknown>;

type JestEnvironment = typeof jestGlobal;
type UnstableMockModule = (
  ...args: Parameters<typeof jestGlobal.mock>
) => ReturnType<typeof jestGlobal.mock>;
const unstableMockModule = (
  jestGlobal as JestEnvironment & { unstable_mockModule: UnstableMockModule }
).unstable_mockModule;

let getJsonMock: jest.MockedFunction<GetJsonMock>;
await unstableMockModule('@/utils/http.js', () => ({
  getJson: (...args: Parameters<GetJsonMock>) => getJsonMock(...args),
}));

const { fetchIssueDetails } = await import('@/lib/github.js');

describe('GitHub issue details', () => {
  beforeEach(() => {
    getJsonMock = jestGlobal.fn<GetJsonMock>();
  });

  test('normalizes issue details from a valid GitHub API response', async () => {
    getJsonMock.mockResolvedValue({
      number: 101,
      title: 'Fix memory leak in XML parser',
      body: '## Problem\nLarge XML files cause runaway memory consumption.',
      user: { login: 'octocat' },
      html_url: 'https://github.com/octo/repo/issues/101',
    });

    await expect(
      fetchIssueDetails('octo', 'repo', 101, 'dummy-token'),
    ).resolves.toEqual({
      status: 'success',
      data: {
        number: 101,
        title: 'Fix memory leak in XML parser',
        body: '## Problem\nLarge XML files cause runaway memory consumption.',
        author: 'octocat',
        url: 'https://github.com/octo/repo/issues/101',
      },
    });
  });

  test('handles null body by converting to empty string', async () => {
    getJsonMock.mockResolvedValue({
      number: 102,
      title: 'Issue without description',
      body: null,
      user: { login: 'alice' },
      html_url: 'https://github.com/octo/repo/issues/102',
    });

    await expect(fetchIssueDetails('octo', 'repo', 102)).resolves.toEqual({
      status: 'success',
      data: {
        number: 102,
        title: 'Issue without description',
        body: '',
        author: 'alice',
        url: 'https://github.com/octo/repo/issues/102',
      },
    });
  });

  test('reports not-found when the item is a pull request instead of an issue', async () => {
    getJsonMock.mockResolvedValue({
      number: 103,
      title: 'PR returned from issues endpoint',
      body: 'PR body',
      pull_request: {
        url: 'https://api.github.com/repos/octo/repo/pulls/103',
      },
      html_url: 'https://github.com/octo/repo/pull/103',
    });

    const result = await fetchIssueDetails('octo', 'repo', 103);
    expect(result.status).toBe('not-found');
    if (result.status === 'not-found') {
      expect(result.statusCode).toBe(404);
      expect(result.message).toContain('is a pull request');
    }
  });

  test('discriminates 404 not-found failure', async () => {
    const error404 = new Error('Not Found');
    Object.assign(error404, { status: 404 });
    getJsonMock.mockRejectedValue(error404);

    const result = await fetchIssueDetails('octo', 'repo', 404);
    expect(result).toEqual({
      status: 'not-found',
      message: 'Issue #404 not found (404)',
      statusCode: 404,
    });
  });

  test('discriminates 401 unauthenticated failure', async () => {
    const error401 = new Error('Bad credentials');
    Object.assign(error401, { status: 401 });
    getJsonMock.mockRejectedValue(error401);

    const result = await fetchIssueDetails('octo', 'repo', 105);
    expect(result.status).toBe('unauthenticated');
    if (result.status === 'unauthenticated') {
      expect(result.statusCode).toBe(401);
    }
  });

  test('discriminates rate limit failure with retry-after', async () => {
    const error429 = new Error('API rate limit exceeded');
    Object.assign(error429, { status: 429, retryAfter: 60 });
    getJsonMock.mockRejectedValue(error429);

    const result = await fetchIssueDetails('octo', 'repo', 106);
    expect(result.status).toBe('rate-limited');
    if (result.status === 'rate-limited') {
      expect(result.retryAfter).toBe(60);
    }
  });

  test('discriminates invalid schema failure', async () => {
    getJsonMock.mockResolvedValue('invalid-primitive-string-instead-of-object');

    const result = await fetchIssueDetails('octo', 'repo', 107);
    expect(result.status).toBe('invalid-response');
  });
});
