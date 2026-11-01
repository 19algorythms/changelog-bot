#!/usr/bin/env node
// Resolve the commit a published v0.x.x release tag points at.
// The workflow uses this instead of release.target_commitish, which may be a
// branch name and can move after the release is published.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Stable v0.x.x tags. Pre-releases and v1+ do not move the floating v0 tag. */
const V0_RELEASE_TAG_PATTERN = /^v0\.\d+\.\d+$/;

/**
 * Return whether this published tag should move the floating v0 tag.
 * @param {string} releaseTag Tag name from the published release.
 * @returns {boolean} True for tags shaped like v0.11.0.
 */
export function isV0ReleaseTag(releaseTag) {
  return V0_RELEASE_TAG_PATTERN.test(releaseTag);
}

/**
 * Peel a local release tag to the commit it points at.
 * WHY: `^{commit}` follows annotated tags, lightweight tags, and nested tags
 * to the commit object. `git rev-parse <tag>` would return the tag object for
 * an annotated tag.
 * @param {string} repositoryPath Repository that already contains the tag.
 * @param {string} releaseTag Validated v0.x.x tag name.
 * @returns {string} Full commit SHA.
 */
export function resolveLocalTagCommit(repositoryPath, releaseTag) {
  if (!isV0ReleaseTag(releaseTag)) {
    throw new Error(`Refusing to resolve non-v0 tag: ${releaseTag}`);
  }

  try {
    return execFileSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${releaseTag}^{commit}`],
      {
        cwd: repositoryPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String(error.stderr).trim()
        : '';
    throw new Error(stderr || `Could not resolve ${releaseTag}`, {
      cause: error,
    });
  }
}

/**
 * Fetch the published tag ref into the local clone.
 * WHY: The release workflow checks out the default branch. That checkout does
 * not guarantee the new tag is present, and a branch tip can differ from the
 * tagged commit.
 * @param {string} repositoryPath Repository whose origin has the tag.
 * @param {string} releaseTag Validated v0.x.x tag name.
 */
export function fetchReleaseTag(repositoryPath, releaseTag) {
  if (!isV0ReleaseTag(releaseTag)) {
    throw new Error(`Refusing to fetch non-v0 tag: ${releaseTag}`);
  }

  execFileSync(
    'git',
    ['fetch', 'origin', `+refs/tags/${releaseTag}:refs/tags/${releaseTag}`],
    { cwd: repositoryPath, stdio: 'inherit' },
  );
}

/**
 * Parse CLI arguments.
 * @param {string[]} argv Arguments after the node executable and script path.
 * @returns {{ fetchFromOrigin: boolean, releaseTag: string }}
 */
export function parseResolveArgs(argv) {
  let fetchFromOrigin = true;
  let releaseTag;

  for (const arg of argv) {
    if (arg === '--no-fetch') {
      fetchFromOrigin = false;
      continue;
    }
    if (releaseTag) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    releaseTag = arg;
  }

  if (!releaseTag) {
    throw new Error('Release tag is required');
  }

  return { fetchFromOrigin, releaseTag };
}

/**
 * Print `skip` or the release commit. Skip happens before any git command.
 * @param {string[]} argv CLI arguments.
 * @param {string} repositoryPath Working repository.
 * @returns {string} `skip` or a commit SHA.
 */
export function resolveV0TagTarget(argv, repositoryPath) {
  const { fetchFromOrigin, releaseTag } = parseResolveArgs(argv);
  if (!isV0ReleaseTag(releaseTag)) {
    return 'skip';
  }

  if (fetchFromOrigin) {
    fetchReleaseTag(repositoryPath, releaseTag);
  }

  return resolveLocalTagCommit(repositoryPath, releaseTag);
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (import.meta.url === entryPoint) {
  try {
    const target = resolveV0TagTarget(process.argv.slice(2), process.cwd());
    process.stdout.write(`${target}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
