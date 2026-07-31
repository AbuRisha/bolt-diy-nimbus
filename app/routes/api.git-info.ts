import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';

export async function loader({ request, context }: LoaderFunctionArgs) {
  // Auth guard: resource routes never run the _index page loader. Kept outside the try so the 401 is not downgraded.
  const env = resolveNimbusEnv(context?.cloudflare?.env);
  const denied = await requireBuilderAuth(request, env);

  if (denied) {
    return denied;
  }

  try {
    // Check if we're in a git repository
    if (!existsSync('.git')) {
      return json({
        branch: 'unknown',
        commit: 'unknown',
        isDirty: false,
      });
    }

    // Get current branch
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();

    // Get current commit hash
    const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

    // Check if working directory is dirty
    const statusOutput = execSync('git status --porcelain', { encoding: 'utf8' });
    const isDirty = statusOutput.trim().length > 0;

    // Get remote URL
    let remoteUrl: string | undefined;

    try {
      remoteUrl = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    } catch {
      // No remote origin, leave as undefined
    }

    // Get last commit info
    let lastCommit: { message: string; date: string; author: string } | undefined;

    try {
      const commitInfo = execSync('git log -1 --pretty=format:"%s|%ci|%an"', { encoding: 'utf8' }).trim();
      const [message, date, author] = commitInfo.split('|');
      lastCommit = {
        message: message || 'unknown',
        date: date || 'unknown',
        author: author || 'unknown',
      };
    } catch {
      // Could not get commit info
    }

    return json({
      branch,
      commit,
      isDirty,
      remoteUrl,
      lastCommit,
    });
  } catch (error) {
    console.error('Error fetching git info:', error);
    return json(
      {
        branch: 'error',
        commit: 'error',
        isDirty: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
