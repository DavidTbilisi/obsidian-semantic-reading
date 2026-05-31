// Inline syntax:
//   {{Tag|text}}                          — plain tagged text
//   {{Tag|text|note=annotation}}          — with attached note
//   {{Tag|[[target]]}}                    — tag wraps a wikilink (display = target)
//   {{Tag|[[target|display]]}}            — wikilink with explicit display text
//   {{Tag|[[target]]|note=annotation}}    — wikilink with note
//
// Constraints: tag = letters + digits starting with a letter; plain text contains no `|` or `}`;
// note contains no `}`; wikilink target/display contain no `]`.

export const MARK_REGEX =
  /\{\{([A-Za-z][A-Za-z0-9]*)\|(\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|[^}|]+?)(?:\|note=([^}]*))?\}\}/g;

// Capture group meanings:
//   1: tag
//   2: full content body (either `[[…]]` literal or plain text)
//   3: wikilink target (only when content was `[[…]]`)
//   4: wikilink display (optional, only inside a wikilink)
//   5: note value (optional)

export interface Segment {
  text: string;       // display text (what the reader sees)
  tag?: string;
  note?: string;
  wikilink?: string;  // wikilink target, only set when content was `[[target]]`
}

export type Paragraph = Segment[];

export interface ParsedSegment extends Segment {
  rawStart: number;
  rawEnd: number;
  plainStart: number;
  plainEnd: number;
}

// A paragraph block, plus any trailing Obsidian block-ID stripped from its text.
export interface ParagraphBlock {
  text: string;
  start: number;
  end: number;
  blockId?: string;     // block id without leading `^`
  blockIdRaw?: string;  // exact text we stripped (e.g. ` ^p2-sr`)
}

const BLOCK_ID_RE = /(\s|^)\^([A-Za-z0-9-]+)\s*$/;

export function parseBody(body: string): Paragraph[] {
  return splitParagraphs(body).map(b => parseParagraph(b.text).map(stripOffsets));
}

export function splitParagraphs(body: string): ParagraphBlock[] {
  const out: ParagraphBlock[] = [];
  const re = /\n[ \t]*\n+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    pushBlock(out, body, last, m.index);
    last = re.lastIndex;
  }
  pushBlock(out, body, last, body.length);
  return out;
}

function pushBlock(out: ParagraphBlock[], body: string, s: number, e: number): void {
  const slice = body.slice(s, e);
  if (!slice.replace(/^\s+|\s+$/g, '').length) return;
  let i = s, j = e;
  while (i < j && /\s/.test(body[i])) i++;
  while (j > i && /\s/.test(body[j - 1])) j--;
  let text = body.slice(i, j);
  let blockId: string | undefined;
  let blockIdRaw: string | undefined;
  const m = BLOCK_ID_RE.exec(text);
  if (m) {
    blockId = m[2];
    blockIdRaw = m[0];
    text = text.slice(0, m.index + (m[1] === '\n' ? 0 : 0)).replace(/\s+$/, '');
  }
  const block: ParagraphBlock = { text, start: i, end: j };
  if (blockId) {
    block.blockId = blockId;
    block.blockIdRaw = blockIdRaw;
  }
  out.push(block);
}

// Compute the display text portion of a mark's content (group 2).
function displayFromContent(g2: string, g3: string | undefined, g4: string | undefined): string {
  if (g3 === undefined) return g2;
  if (g4) return g4;
  // No explicit display — use the basename of the target (Concepts/cognition → cognition).
  const idx = g3.lastIndexOf('/');
  return idx >= 0 ? g3.slice(idx + 1) : g3;
}

export function parseParagraph(raw: string): ParsedSegment[] {
  const out: ParsedSegment[] = [];
  let rawPos = 0;
  let plainPos = 0;
  const re = new RegExp(MARK_REGEX.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > rawPos) {
      const text = raw.slice(rawPos, m.index);
      out.push({
        text,
        rawStart: rawPos,
        rawEnd: m.index,
        plainStart: plainPos,
        plainEnd: plainPos + text.length,
      });
      plainPos += text.length;
    }
    const tag = m[1];
    const content = m[2];
    const wikilinkTarget = m[3];
    const wikilinkDisplay = m[4];
    const note = m[5];
    const display = displayFromContent(content, wikilinkTarget, wikilinkDisplay);
    const seg: ParsedSegment = {
      text: display,
      tag,
      rawStart: m.index,
      rawEnd: m.index + m[0].length,
      plainStart: plainPos,
      plainEnd: plainPos + display.length,
    };
    if (wikilinkTarget) seg.wikilink = wikilinkTarget;
    if (note !== undefined) seg.note = note;
    out.push(seg);
    plainPos += display.length;
    rawPos = m.index + m[0].length;
  }
  if (rawPos < raw.length) {
    const text = raw.slice(rawPos);
    out.push({
      text,
      rawStart: rawPos,
      rawEnd: raw.length,
      plainStart: plainPos,
      plainEnd: plainPos + text.length,
    });
  }
  return out;
}

export function stripOffsets(s: ParsedSegment): Segment {
  const out: Segment = { text: s.text };
  if (s.tag) out.tag = s.tag;
  if (s.note) out.note = s.note;
  if (s.wikilink) out.wikilink = s.wikilink;
  return out;
}

export function plainTextOf(segs: Segment[]): string {
  return segs.map(s => s.text).join('');
}

export function serializeSegment(s: Segment): string {
  if (!s.tag) return s.text;
  let body: string;
  if (s.wikilink) {
    // Only emit `|display` when display text differs from the basename of the target.
    const basename = s.wikilink.slice(s.wikilink.lastIndexOf('/') + 1);
    body = s.text === basename || s.text === s.wikilink
      ? `[[${s.wikilink}]]`
      : `[[${s.wikilink}|${s.text}]]`;
  } else {
    body = s.text;
  }
  let out = '{{' + s.tag + '|' + body;
  if (s.note) out += '|note=' + s.note;
  out += '}}';
  return out;
}

export function serializeParagraph(segs: Segment[]): string {
  return segs.map(serializeSegment).join('');
}

export function applyTagRange(
  segs: Segment[],
  startChar: number,
  endChar: number,
  tag: string
): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const seg of segs) {
    const segStart = pos;
    const segEnd = pos + seg.text.length;
    pos = segEnd;
    if (segEnd <= startChar || segStart >= endChar) {
      out.push(seg);
      continue;
    }
    const a = Math.max(startChar, segStart);
    const b = Math.min(endChar, segEnd);
    const before = seg.text.slice(0, a - segStart);
    const middle = seg.text.slice(a - segStart, b - segStart);
    const after = seg.text.slice(b - segStart);
    // Splitting a wikilinked segment drops the wikilink (sub-spans of a link aren't linkable).
    const carryWikilink = before === '' && after === '' ? seg.wikilink : undefined;
    if (before) out.push(seg.tag ? cloneSeg({ ...seg, text: before }) : { text: before });
    if (middle) {
      const mid: Segment = { text: middle, tag };
      if (carryWikilink) mid.wikilink = carryWikilink;
      out.push(mid);
    }
    if (after) out.push(seg.tag ? cloneSeg({ ...seg, text: after }) : { text: after });
  }
  return mergeAdjacent(out);
}

function cloneSeg(s: Segment): Segment {
  const o: Segment = { text: s.text };
  if (s.tag) o.tag = s.tag;
  if (s.note) o.note = s.note;
  // Wikilinks survive only when the whole segment is preserved (handled by caller).
  return o;
}

// Promote a tagged segment to a wikilink-bearing variant in place.
export function promoteSegmentToWikilink(
  segs: Segment[],
  index: number,
  target: string
): Segment[] {
  return segs.map((s, i) => {
    if (i !== index) return s;
    if (!s.tag) return s;
    const o: Segment = { text: s.text, tag: s.tag, wikilink: target };
    if (s.note) o.note = s.note;
    return o;
  });
}

export function removeTagAt(segs: Segment[], index: number): Segment[] {
  if (!segs[index]) return segs;
  const out = segs.map((s, i) => (i !== index ? s : { text: s.text }));
  return mergeAdjacent(out);
}

export function mergeAdjacent(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if (!s.text) continue;
    const prev = out[out.length - 1];
    if (
      prev &&
      (prev.tag || null) === (s.tag || null) &&
      (prev.note || '') === (s.note || '') &&
      (prev.wikilink || '') === (s.wikilink || '')
    ) {
      prev.text += s.text;
    } else {
      const copy: Segment = { text: s.text };
      if (s.tag) copy.tag = s.tag;
      if (s.note) copy.note = s.note;
      if (s.wikilink) copy.wikilink = s.wikilink;
      out.push(copy);
    }
  }
  return out;
}

export function rawToPlain(parsed: ParsedSegment[], rawPos: number): number {
  for (const seg of parsed) {
    if (rawPos <= seg.rawStart) return seg.plainStart;
    if (rawPos < seg.rawEnd) {
      if (!seg.tag) return seg.plainStart + (rawPos - seg.rawStart);
      // Inside a tagged span; clamp to the display-text bounds. We can't be more
      // precise without re-parsing the inner content, and that's fine for selection mapping.
      return seg.plainStart;
    }
  }
  return parsed.length ? parsed[parsed.length - 1].plainEnd : 0;
}

export function findParagraphAt(body: string, docOffset: number): ParagraphBlock | null {
  const blocks = splitParagraphs(body);
  for (const b of blocks) {
    if (docOffset >= b.start && docOffset <= b.end) return b;
  }
  return null;
}

export function findParagraphIndexAt(body: string, docOffset: number): number {
  const blocks = splitParagraphs(body);
  for (let i = 0; i < blocks.length; i++) {
    if (docOffset >= blocks[i].start && docOffset <= blocks[i].end) return i;
  }
  return -1;
}

// Like findParagraphAt, but also returns the paragraph's index. Saves a duplicate splitParagraphs.
export function findParagraphWithIndexAt(
  body: string,
  docOffset: number
): { block: ParagraphBlock; index: number } | null {
  const blocks = splitParagraphs(body);
  for (let i = 0; i < blocks.length; i++) {
    if (docOffset >= blocks[i].start && docOffset <= blocks[i].end) {
      return { block: blocks[i], index: i };
    }
  }
  return null;
}

// === Block IDs ===

// Build the canonical block-id for paragraph index `pi` (0-based).
export function blockIdFor(paraIndex: number): string {
  return 'p' + (paraIndex + 1) + '-sr';
}

// Given a body and paragraph index, ensure that paragraph ends with `^<id>`. Returns the new body.
export function ensureBlockId(body: string, paraIndex: number, blockId: string): string {
  const blocks = splitParagraphs(body);
  if (paraIndex < 0 || paraIndex >= blocks.length) return body;
  const b = blocks[paraIndex];
  if (b.blockId === blockId) return body;
  const before = body.slice(0, b.start);
  const after = body.slice(b.end);
  let text = b.text;
  if (b.blockId && b.blockIdRaw) {
    // Replace existing block id (rare — we never want to clobber a user-set one).
    if (b.blockId !== blockId) return body;
  }
  const trailing = text.endsWith('\n') ? '' : ' ';
  return before + text + trailing + '^' + blockId + after;
}

// === Pure data builders (ported from js/export.js) ===

export function countTags(paragraphs: Paragraph[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const segs of paragraphs) {
    for (const s of segs) {
      if (s.tag) c[s.tag] = (c[s.tag] || 0) + 1;
    }
  }
  return c;
}

export interface Extract {
  tag: string;
  text: string;
  paragraph: number;
  note?: string;
  wikilink?: string;
}

export function flatExtracts(
  paragraphs: Paragraph[],
  filter?: (s: Segment) => boolean
): Extract[] {
  const out: Extract[] = [];
  paragraphs.forEach((segs, pi) => {
    segs.forEach(s => {
      if (!s.tag) return;
      if (filter && !filter(s)) return;
      const item: Extract = { tag: s.tag, text: s.text.trim(), paragraph: pi + 1 };
      if (s.note) item.note = s.note;
      if (s.wikilink) item.wikilink = s.wikilink;
      out.push(item);
    });
  });
  return out;
}

// Normalize a Def's display text into a canonical hub-page slug.
// "Industrialization" → "industrialization"; "Public health!" → "public-health"
export function canonicalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
