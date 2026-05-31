// Readwise + Kindle highlights importer.
//
// Readwise: paginates GET /api/v2/export/ and writes one note per book into
// the destination folder. Each note's frontmatter carries the Readwise book id
// so re-imports can skip already-imported books (we don't overwrite — the
// expectation is the user tags the highlights with sigils after import).
//
// Kindle: parses a `My Clippings.txt` file (paste/upload) and writes the same
// per-book note shape, with `source: Kindle` instead of `source: Readwise`.

import { App, normalizePath, TFile, TFolder, requestUrl } from 'obsidian';

export interface ReadwiseOptions {
  token: string;
  destFolder: string;          // e.g. "Readwise"
  lastUpdated: string;         // ISO; passed as updatedAfter to Readwise. Empty = full sync.
}

export const DEFAULT_READWISE_OPTIONS: ReadwiseOptions = {
  token: '',
  destFolder: 'Readwise',
  lastUpdated: '',
};

interface ReadwiseHighlight {
  id: number;
  text: string;
  note: string;
  location: number | null;
  location_type: string;
  highlighted_at: string | null;
  url: string | null;
  readwise_url: string;
  tags: Array<{ id: number; name: string }>;
}

interface ReadwiseBook {
  user_book_id: number;
  title: string;
  author: string;
  readable_title: string;
  source: string;
  source_url: string | null;
  category: string;
  cover_image_url: string | null;
  highlights: ReadwiseHighlight[];
}

interface ReadwiseExportResponse {
  count: number;
  nextPageCursor: string | null;
  results: ReadwiseBook[];
}

async function fetchExportPage(token: string, updatedAfter: string, cursor: string | null): Promise<ReadwiseExportResponse> {
  const qs = new URLSearchParams();
  if (updatedAfter) qs.set('updatedAfter', updatedAfter);
  if (cursor) qs.set('pageCursor', cursor);
  const url = 'https://readwise.io/api/v2/export/' + (qs.toString() ? `?${qs.toString()}` : '');
  const res = await requestUrl({
    url,
    method: 'GET',
    headers: { Authorization: `Token ${token}` },
    throw: false,
  });
  if (res.status === 401 || res.status === 403) throw new Error('Readwise auth failed — check your token');
  if (res.status >= 400) throw new Error(`Readwise HTTP ${res.status}`);
  return res.json as ReadwiseExportResponse;
}

export async function fetchAllBooks(token: string, updatedAfter: string): Promise<ReadwiseBook[]> {
  const out: ReadwiseBook[] = [];
  let cursor: string | null = null;
  do {
    const page = await fetchExportPage(token, updatedAfter, cursor);
    out.push(...page.results);
    cursor = page.nextPageCursor;
  } while (cursor);
  return out;
}

export function safeFilename(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'untitled';
}

function frontmatter(record: Record<string, string | number | null | undefined>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null || v === '') continue;
    const str = String(v).replace(/"/g, '\\"');
    lines.push(`${k}: "${str}"`);
  }
  lines.push('semantic_domain: ');
  lines.push('---');
  return lines.join('\n');
}

export function noteForReadwiseBook(book: ReadwiseBook): string {
  const fm = frontmatter({
    source: 'Readwise',
    source_url: book.source_url || '',
    author: book.author,
    category: book.category,
    readwise_book_id: book.user_book_id,
  });
  const parts: string[] = [fm, '', `# ${book.title}`, ''];
  if (book.author) parts.push(`*by ${book.author}*`, '');
  for (const h of book.highlights) {
    parts.push(highlightBlock(h.text, h.note, h.location, h.location_type, h.readwise_url));
    parts.push('');
  }
  return parts.join('\n');
}

function highlightBlock(text: string, note: string, location: number | null, locType: string, link: string): string {
  const quoted = text.split('\n').map(l => `> ${l}`).join('\n');
  const meta: string[] = [];
  if (location !== null) meta.push(`${locType || 'location'} ${location}`);
  if (link) meta.push(`[↗](${link})`);
  const tail = meta.length ? `> \n> *${meta.join(' · ')}*` : '';
  const noteBlock = note ? `\n\nNote: ${note}` : '';
  return [quoted, tail, noteBlock].filter(Boolean).join('\n');
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFolder) return;
  if (existing) throw new Error(`${path} exists but is not a folder`);
  await app.vault.createFolder(path);
}

export interface ReadwiseImportResult {
  created: number;
  skipped: number;
  failed: number;
  errors: string[];
  newLastUpdated: string;
}

export async function importReadwise(
  app: App,
  opts: ReadwiseOptions,
  now = new Date(),
): Promise<ReadwiseImportResult> {
  if (!opts.token) throw new Error('Missing Readwise token');
  await ensureFolder(app, opts.destFolder);
  const books = await fetchAllBooks(opts.token, opts.lastUpdated);

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const book of books) {
    if (!book.highlights.length) { skipped++; continue; }
    const path = normalizePath(`${opts.destFolder}/${safeFilename(book.title)}.md`);
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) { skipped++; continue; } // expectation: user has tagged highlights; don't clobber
    try {
      await app.vault.create(path, noteForReadwiseBook(book));
      created++;
    } catch (err) {
      failed++;
      errors.push(`${book.title}: ${(err as Error).message}`);
    }
  }
  return {
    created, skipped, failed, errors,
    newLastUpdated: now.toISOString(),
  };
}

// ---------- Kindle My Clippings.txt ----------

export interface KindleClipping {
  title: string;
  author: string;
  text: string;
  location: string;
  addedAt: string;
}

// Parses the standard Kindle format. Each clipping is separated by `==========`:
//
//   Title (Author Name)
//   - Your Highlight on Location 100-101 | Added on Sunday, January 1, 2025 ...
//
//   Highlight text...
//   ==========
//
// Title sometimes has no parens around the author when the title itself has
// parens; we fall back to "Unknown".
export function parseKindleClippings(text: string): KindleClipping[] {
  const chunks = text.split(/^={5,}\s*$/m).map(c => c.trim()).filter(Boolean);
  const out: KindleClipping[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    if (lines.length < 3) continue;
    const titleLine = lines[0].trim();
    const meta = lines[1].trim();
    const body = lines.slice(2).join('\n').trim();
    if (!body) continue;

    let title = titleLine;
    let author = 'Unknown';
    const authMatch = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(titleLine);
    if (authMatch) {
      title = authMatch[1].trim();
      author = authMatch[2].trim();
    }
    const locMatch = /Location\s+([\d-]+)/i.exec(meta);
    const dateMatch = /Added on\s+(.+)$/i.exec(meta);
    out.push({
      title,
      author,
      text: body,
      location: locMatch ? locMatch[1] : '',
      addedAt: dateMatch ? dateMatch[1].trim() : '',
    });
  }
  return out;
}

export function noteForKindleBook(title: string, author: string, clippings: KindleClipping[]): string {
  const fm = frontmatter({
    source: 'Kindle',
    author,
  });
  const parts: string[] = [fm, '', `# ${title}`, ''];
  if (author && author !== 'Unknown') parts.push(`*by ${author}*`, '');
  for (const c of clippings) {
    const quoted = c.text.split('\n').map(l => `> ${l}`).join('\n');
    const meta = [c.location && `location ${c.location}`, c.addedAt].filter(Boolean).join(' · ');
    parts.push(quoted);
    if (meta) parts.push(`> \n> *${meta}*`);
    parts.push('');
  }
  return parts.join('\n');
}

export async function importKindleClippings(
  app: App,
  rawText: string,
  destFolder: string,
): Promise<{ created: number; skipped: number; books: number }> {
  await ensureFolder(app, destFolder);
  const clippings = parseKindleClippings(rawText);
  const byBook = new Map<string, { author: string; clippings: KindleClipping[] }>();
  for (const c of clippings) {
    const key = c.title;
    const entry = byBook.get(key) || { author: c.author, clippings: [] };
    entry.clippings.push(c);
    byBook.set(key, entry);
  }
  let created = 0;
  let skipped = 0;
  for (const [title, entry] of byBook) {
    const path = normalizePath(`${destFolder}/${safeFilename(title)}.md`);
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) { skipped++; continue; }
    await app.vault.create(path, noteForKindleBook(title, entry.author, entry.clippings));
    created++;
  }
  return { created, skipped, books: byBook.size };
}
