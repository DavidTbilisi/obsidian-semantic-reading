// .ics calendar export. An A-tagged span co-located in a paragraph with a
// D-tagged span becomes one VEVENT. Subscribe to the generated file from
// Calendar.app, Fantastical, Google Calendar, etc.
//
// UID per event: `srid:<blockId>@semantic-reading` — stable across runs so
// calendar apps update rather than duplicate when actions are re-exported.

import { App, normalizePath, TFile } from 'obsidian';
import { VaultIndex, Mention } from '../graph/vault-index';

export interface IcsEvent {
  uid: string;          // srid:<blockId>@semantic-reading
  summary: string;      // A-tag text
  start: ParsedDate;
  description?: string;
  notePath: string;
  blockId: string;
}

export interface ParsedDate {
  raw: string;
  // Date-only (all-day event) or date-time (floating, no TZ).
  kind: 'date' | 'date-time';
  // YYYYMMDD for date, YYYYMMDDTHHMMSS for date-time.
  ics: string;
}

const DATE_RE = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/;
const DATE_TIME_RE = /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*$/;

export function parseDate(text: string): ParsedDate | null {
  const dt = DATE_TIME_RE.exec(text);
  if (dt) {
    const [, y, m, d, hh, mm, ss = '00'] = dt;
    return { raw: text.trim(), kind: 'date-time', ics: `${y}${m}${d}T${hh}${mm}${ss}` };
  }
  const ymd = DATE_RE.exec(text);
  if (ymd) {
    const [, y, m, d] = ymd;
    return { raw: text.trim(), kind: 'date', ics: `${y}${m}${d}` };
  }
  return null;
}

// Pair every A-tagged mention with the first parseable D-tagged mention in the
// same paragraph of the same note. Drops A-spans with no co-located date.
export function pairActionsWithDates(index: VaultIndex): IcsEvent[] {
  const actions = index.byTag['A'] || [];
  const dates = index.byTag['D'] || [];
  // Index dates by notePath -> paraIndex -> Mention[]
  const dateLookup = new Map<string, Map<number, Mention[]>>();
  for (const d of dates) {
    let perNote = dateLookup.get(d.notePath);
    if (!perNote) { perNote = new Map(); dateLookup.set(d.notePath, perNote); }
    const list = perNote.get(d.paraIndex) || [];
    list.push(d);
    perNote.set(d.paraIndex, list);
  }

  const out: IcsEvent[] = [];
  for (const a of actions) {
    const candidates = dateLookup.get(a.notePath)?.get(a.paraIndex);
    if (!candidates) continue;
    let parsed: ParsedDate | null = null;
    for (const d of candidates) {
      parsed = parseDate(d.text);
      if (parsed) break;
    }
    if (!parsed) continue;
    out.push({
      uid: `srid:${a.blockId}-${a.notePath}@semantic-reading`,
      summary: a.text.trim(),
      start: parsed,
      description: a.note,
      notePath: a.notePath,
      blockId: a.blockId,
    });
  }
  return out;
}

// RFC 5545 line-folding: lines > 75 octets must be split with CRLF + space.
// Plain ASCII assumed for safety; non-ASCII in summaries is rare for actions.
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let i = 0;
  while (i < line.length) {
    chunks.push(line.slice(i, i + (i === 0 ? 75 : 74)));
    i += i === 0 ? 75 : 74;
  }
  return chunks.join('\r\n ');
}

function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

export function buildIcs(events: IcsEvent[], now = new Date()): string {
  const dtstamp = formatStamp(now);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//semantic-reading//actions//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const e of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(foldLine(`UID:${escapeText(e.uid)}`));
    lines.push(`DTSTAMP:${dtstamp}`);
    if (e.start.kind === 'date') {
      lines.push(`DTSTART;VALUE=DATE:${e.start.ics}`);
    } else {
      lines.push(`DTSTART:${e.start.ics}`);
    }
    lines.push(foldLine(`SUMMARY:${escapeText(e.summary)}`));
    const link = `obsidian://open?file=${encodeURIComponent(e.notePath.replace(/\.md$/, ''))}#^${e.blockId}`;
    const descParts = [e.description, link].filter(Boolean) as string[];
    if (descParts.length) lines.push(foldLine(`DESCRIPTION:${escapeText(descParts.join('\n'))}`));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function formatStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export async function writeActionsIcs(
  app: App,
  index: VaultIndex,
  path: string,
): Promise<{ path: string; count: number }> {
  const events = pairActionsWithDates(index);
  const content = buildIcs(events);
  const norm = normalizePath(path);
  const existing = app.vault.getAbstractFileByPath(norm);
  if (existing instanceof TFile) await app.vault.modify(existing, content);
  else await app.vault.create(norm, content);
  return { path: norm, count: events.length };
}
