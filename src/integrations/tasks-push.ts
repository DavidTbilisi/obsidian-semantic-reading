// Task-manager push. Every A-tagged span across the vault becomes one task in
// an external app: Todoist (REST v2, server-side) or Things 3 (x-callback-url,
// local). Each task carries a stable `srid_<blockId>` label/tag so re-running
// the sync updates the de-dupe set instead of creating duplicates.
//
// Domain-aware routing: if a note's `semantic_domain` frontmatter matches an
// entry in `projectByDomain`, the action lands in that project/list. Otherwise
// it falls back to `defaultProject` (Todoist) or the inbox (Things).

import { requestUrl } from 'obsidian';
import { VaultIndex, Mention } from '../graph/vault-index';

export type TaskProvider = 'none' | 'todoist' | 'things';

export interface TasksPushOptions {
  provider: TaskProvider;
  todoistToken: string;
  defaultProject: string;                // Todoist project id (or empty = Inbox)
  projectByDomain: Record<string, string>; // domain -> Todoist project id / Things list name
  syncedSrids: string[];                 // local dedup record for URL-scheme providers
}

export const DEFAULT_TASKS_PUSH_OPTIONS: TasksPushOptions = {
  provider: 'none',
  todoistToken: '',
  defaultProject: '',
  projectByDomain: {},
  syncedSrids: [],
};

export interface TasksPushResult {
  added: number;
  skipped: number;
  failed: number;
  errors: string[];
  // Updated dedup record — caller persists it back to settings for URL-scheme providers.
  syncedSrids: string[];
}

export interface TasksPushDeps {
  // Resolve `semantic_domain` for a note path. Lets tasks-push stay free of
  // direct plugin/metadataCache imports.
  resolveDomain(notePath: string): string | null;
  // For Things: launch the x-callback-url. Defaulted to window.open so tests
  // can override.
  openUrl?: (url: string) => void;
}

function sridLabel(blockId: string, notePath: string): string {
  // Both Todoist labels and Things tags must be safe identifiers; strip to
  // alphanumerics+underscore and prefix.
  return 'srid_' + (blockId + '_' + notePath).replace(/[^A-Za-z0-9]/g, '_');
}

export async function pushActions(
  index: VaultIndex,
  opts: TasksPushOptions,
  deps: TasksPushDeps,
): Promise<TasksPushResult> {
  if (opts.provider === 'none') {
    return { added: 0, skipped: 0, failed: 0, errors: ['No provider selected'], syncedSrids: opts.syncedSrids };
  }
  const actions = index.byTag['A'] || [];
  if (opts.provider === 'todoist') {
    return pushTodoist(actions, opts, deps);
  }
  if (opts.provider === 'things') {
    return pushThings(actions, opts, deps);
  }
  return { added: 0, skipped: 0, failed: 0, errors: [`Unknown provider: ${opts.provider}`], syncedSrids: opts.syncedSrids };
}

// ---------- Todoist ----------

interface TodoistTask {
  id: string;
  content: string;
  labels: string[];
  project_id: string;
}

async function todoistGetTasks(token: string): Promise<TodoistTask[]> {
  const res = await requestUrl({
    url: 'https://api.todoist.com/rest/v2/tasks',
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    throw: false,
  });
  if (res.status >= 400) throw new Error(`Todoist GET /tasks → HTTP ${res.status}`);
  return res.json as TodoistTask[];
}

async function todoistCreateTask(token: string, body: Record<string, unknown>): Promise<TodoistTask> {
  const res = await requestUrl({
    url: 'https://api.todoist.com/rest/v2/tasks',
    method: 'POST',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    throw: false,
  });
  if (res.status >= 400) throw new Error(`Todoist POST /tasks → HTTP ${res.status}`);
  return res.json as TodoistTask;
}

async function pushTodoist(
  actions: Mention[],
  opts: TasksPushOptions,
  deps: TasksPushDeps,
): Promise<TasksPushResult> {
  const errors: string[] = [];
  if (!opts.todoistToken) {
    return { added: 0, skipped: 0, failed: 0, errors: ['Missing Todoist API token'], syncedSrids: opts.syncedSrids };
  }

  let existing: TodoistTask[];
  try {
    existing = await todoistGetTasks(opts.todoistToken);
  } catch (err) {
    return { added: 0, skipped: 0, failed: 1, errors: [(err as Error).message], syncedSrids: opts.syncedSrids };
  }
  const have = new Set<string>();
  for (const t of existing) {
    for (const l of t.labels) if (l.startsWith('srid_')) have.add(l);
  }

  let added = 0;
  let skipped = 0;
  let failed = 0;
  for (const a of actions) {
    const srid = sridLabel(a.blockId, a.notePath);
    if (have.has(srid)) { skipped++; continue; }
    const domain = deps.resolveDomain(a.notePath);
    const project = (domain && opts.projectByDomain[domain]) || opts.defaultProject || undefined;
    const body: Record<string, unknown> = {
      content: a.text.trim() || '(empty action)',
      labels: [srid],
      description: `${a.notePath}#^${a.blockId}` + (a.note ? `\n\n${a.note}` : ''),
    };
    if (project) body.project_id = project;
    try {
      await todoistCreateTask(opts.todoistToken, body);
      added++;
    } catch (err) {
      failed++;
      errors.push(`${a.text.slice(0, 40)}: ${(err as Error).message}`);
    }
  }
  return { added, skipped, failed, errors, syncedSrids: opts.syncedSrids };
}

// ---------- Things 3 ----------

function thingsAddUrl(params: Record<string, string>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `things:///add?${qs}`;
}

async function pushThings(
  actions: Mention[],
  opts: TasksPushOptions,
  deps: TasksPushDeps,
): Promise<TasksPushResult> {
  const errors: string[] = [];
  const have = new Set(opts.syncedSrids);
  const open = deps.openUrl ?? ((url: string) => { window.open(url, '_blank'); });

  let added = 0;
  let skipped = 0;
  let failed = 0;
  for (const a of actions) {
    const srid = sridLabel(a.blockId, a.notePath);
    if (have.has(srid)) { skipped++; continue; }
    const domain = deps.resolveDomain(a.notePath);
    const list = (domain && opts.projectByDomain[domain]) || opts.defaultProject || '';
    const url = thingsAddUrl({
      title: a.text.trim() || '(empty action)',
      notes: `${a.notePath}#^${a.blockId}` + (a.note ? `\n\n${a.note}` : ''),
      tags: srid,
      list,
    });
    try {
      open(url);
      have.add(srid);
      added++;
    } catch (err) {
      failed++;
      errors.push(`${a.text.slice(0, 40)}: ${(err as Error).message}`);
    }
  }
  return { added, skipped, failed, errors, syncedSrids: Array.from(have) };
}
