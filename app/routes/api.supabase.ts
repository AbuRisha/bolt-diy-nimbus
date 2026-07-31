import { json, type ActionFunction } from '@remix-run/cloudflare';
import type { SupabaseProject } from '~/types/supabase';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';

export const action: ActionFunction = async ({ request, context }) => {
  /*
   * Auth guard: resource routes never run the _index page loader, so the SSO
   * check there does not apply here. Kept outside the try below because that
   * catch returns a 401 with a different shape and would otherwise mask this.
   */
  const env = resolveNimbusEnv(context?.cloudflare?.env);
  const denied = await requireBuilderAuth(request, env);

  if (denied) {
    return denied;
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const { token } = (await request.json()) as any;

    const projectsResponse = await fetch('https://api.supabase.com/v1/projects', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!projectsResponse.ok) {
      const errorText = await projectsResponse.text();
      console.error('Projects fetch failed:', errorText);

      return json({ error: 'Failed to fetch projects' }, { status: 401 });
    }

    const projects = (await projectsResponse.json()) as SupabaseProject[];

    const uniqueProjectsMap = new Map<string, SupabaseProject>();

    for (const project of projects) {
      if (!uniqueProjectsMap.has(project.id)) {
        uniqueProjectsMap.set(project.id, project);
      }
    }

    const uniqueProjects = Array.from(uniqueProjectsMap.values());

    uniqueProjects.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return json({
      user: { email: 'Connected', role: 'Admin' },
      stats: {
        projects: uniqueProjects,
        totalProjects: uniqueProjects.length,
      },
    });
  } catch (error) {
    console.error('Supabase API error:', error);
    return json(
      {
        error: error instanceof Error ? error.message : 'Authentication failed',
      },
      { status: 401 },
    );
  }
};
