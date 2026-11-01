import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from '@jest/globals';
import {
  isV0ReleaseTag,
  resolveV0TagTarget,
} from '../../scripts/resolve-v0-tag-target.mjs';

const scriptPath = join(process.cwd(), 'scripts', 'resolve-v0-tag-target.mjs');

function executeGit(repositoryPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repositoryPath,
    encoding: 'utf8',
  }).trim();
}

function createRepository(): string {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'changelog-bot-v0-tag-'));
  executeGit(repositoryPath, ['init', '--initial-branch=main']);
  executeGit(repositoryPath, ['config', 'user.name', 'Changelog Bot Test']);
  executeGit(repositoryPath, [
    'config',
    'user.email',
    'changelog-bot@example.com',
  ]);
  writeFileSync(join(repositoryPath, 'README.md'), 'initial\n', 'utf8');
  executeGit(repositoryPath, ['add', 'README.md']);
  executeGit(repositoryPath, ['commit', '-m', 'chore: initial commit']);
  return repositoryPath;
}

function commitFile(repositoryPath: string, name: string): string {
  writeFileSync(join(repositoryPath, name), `${name}\n`, 'utf8');
  executeGit(repositoryPath, ['add', name]);
  executeGit(repositoryPath, ['commit', '-m', `chore: add ${name}`]);
  return executeGit(repositoryPath, ['rev-parse', 'HEAD']);
}

describe('v0 tag selection', () => {
  const repositories: string[] = [];

  afterEach(() => {
    for (const repositoryPath of repositories.splice(0)) {
      rmSync(repositoryPath, { recursive: true, force: true });
    }
  });

  test('accepts only stable v0.x.x release tags', () => {
    expect(isV0ReleaseTag('v0.11.0')).toBe(true);
    expect(isV0ReleaseTag('v0.0.1')).toBe(true);
    expect(isV0ReleaseTag('v0')).toBe(false);
    expect(isV0ReleaseTag('v0.11')).toBe(false);
    expect(isV0ReleaseTag('v0.11.0-rc.1')).toBe(false);
    expect(isV0ReleaseTag('v1.0.0')).toBe(false);
    expect(isV0ReleaseTag('v1.2.3')).toBe(false);
    expect(isV0ReleaseTag('main')).toBe(false);
  });

  test('resolves a lightweight tag to its commit when the branch has moved ahead', () => {
    const repositoryPath = createRepository();
    repositories.push(repositoryPath);
    const releaseCommit = executeGit(repositoryPath, ['rev-parse', 'HEAD']);
    executeGit(repositoryPath, ['tag', 'v0.1.0', releaseCommit]);
    const laterCommit = commitFile(repositoryPath, 'later.txt');

    expect(resolveV0TagTarget(['--no-fetch', 'v0.1.0'], repositoryPath)).toBe(
      releaseCommit,
    );
    expect(laterCommit).not.toBe(releaseCommit);
    expect(executeGit(repositoryPath, ['tag', '--list', 'v0'])).toBe('');
  });

  test('peels an annotated tag to the tagged commit', () => {
    const repositoryPath = createRepository();
    repositories.push(repositoryPath);
    const releaseCommit = executeGit(repositoryPath, ['rev-parse', 'HEAD']);
    executeGit(repositoryPath, [
      'tag',
      '-a',
      'v0.2.0',
      releaseCommit,
      '-m',
      'release v0.2.0',
    ]);
    commitFile(repositoryPath, 'later.txt');

    const tagObject = executeGit(repositoryPath, [
      'rev-parse',
      '--verify',
      'v0.2.0',
    ]);
    expect(tagObject).not.toBe(releaseCommit);
    expect(executeGit(repositoryPath, ['cat-file', '-t', 'v0.2.0'])).toBe(
      'tag',
    );
    expect(resolveV0TagTarget(['--no-fetch', 'v0.2.0'], repositoryPath)).toBe(
      releaseCommit,
    );
    expect(executeGit(repositoryPath, ['tag', '--list', 'v0'])).toBe('');
  });

  test('skips v1 and pre-release tags before consulting git', () => {
    const repositoryPath = createRepository();
    repositories.push(repositoryPath);
    executeGit(repositoryPath, ['tag', 'v1.0.0']);
    executeGit(repositoryPath, ['tag', 'v0.3.0-rc.1']);

    expect(resolveV0TagTarget(['--no-fetch', 'v1.0.0'], repositoryPath)).toBe(
      'skip',
    );
    expect(
      resolveV0TagTarget(['--no-fetch', 'v0.3.0-rc.1'], repositoryPath),
    ).toBe('skip');
    expect(executeGit(repositoryPath, ['tag', '--list', 'v0'])).toBe('');
  });

  test('fails when a v0.x.x tag is missing and does not create v0', () => {
    const repositoryPath = createRepository();
    repositories.push(repositoryPath);

    expect(() =>
      resolveV0TagTarget(['--no-fetch', 'v0.9.9'], repositoryPath),
    ).toThrow();
    expect(executeGit(repositoryPath, ['tag', '--list', 'v0'])).toBe('');
  });

  test('the release workflow peels the published tag and limits moves to v0', () => {
    const workflow = readFileSync(
      join(process.cwd(), '.github', 'workflows', 'major-tag-update.yaml'),
      'utf8',
    );

    expect(workflow).not.toContain('github.event.release.target_commitish');
    expect(workflow).toContain('scripts/resolve-v0-tag-target.mjs');
    expect(workflow).toContain(
      "startsWith(github.event.release.tag_name, 'v0.')",
    );
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('git push origin refs/tags/v0 --force');
  });

  test('the CLI prints skip or the commit without moving tags', () => {
    const repositoryPath = createRepository();
    repositories.push(repositoryPath);
    const releaseCommit = executeGit(repositoryPath, ['rev-parse', 'HEAD']);
    executeGit(repositoryPath, ['tag', 'v0.4.0']);

    const skipped = execFileSync(
      process.execPath,
      [scriptPath, '--no-fetch', 'v1.2.3'],
      { cwd: repositoryPath, encoding: 'utf8' },
    );
    const resolved = execFileSync(
      process.execPath,
      [scriptPath, '--no-fetch', 'v0.4.0'],
      { cwd: repositoryPath, encoding: 'utf8' },
    );

    expect(skipped).toBe('skip\n');
    expect(resolved).toBe(`${releaseCommit}\n`);
    expect(executeGit(repositoryPath, ['tag', '--list', 'v0'])).toBe('');
  });
});
