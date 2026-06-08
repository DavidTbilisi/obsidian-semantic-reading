// Pure body transform behind the MCP `sr_apply_tag` write tool: wrap a verbatim
// span inside a paragraph with `{{Tag|…}}` markup and ensure the paragraph
// carries a stable block id (so the resulting Mention is addressable). Operates
// on a *frontmatter-stripped* body — the caller re-prepends frontmatter. No
// Obsidian imports, so this is unit-testable in isolation; the vault read/write
// lives in api.ts (`edits.applyTag`).

import {
  applyTagRange,
  blockIdFor,
  ensureBlockId,
  parseParagraph,
  plainTextOf,
  serializeParagraph,
  splitParagraphs,
  stripOffsets,
  Segment,
} from '../syntax';

export interface ApplyTagParams {
  paraIndex: number;
  span: string;        // verbatim substring of the paragraph's plain text
  tag: string;
  note?: string;
}

export interface ApplyTagResult {
  body: string;        // new frontmatter-stripped body
  blockId: string;
  paragraph: string;   // the new serialized paragraph text (without block id)
}

export function applyTagInBody(strippedBody: string, p: ApplyTagParams): ApplyTagResult {
  const blocks = splitParagraphs(strippedBody);
  if (p.paraIndex < 0 || p.paraIndex >= blocks.length) {
    throw new Error(`paraIndex ${p.paraIndex} out of range (note body has ${blocks.length} paragraph(s))`);
  }
  const block = blocks[p.paraIndex];
  const segs = parseParagraph(block.text).map(stripOffsets);
  const plain = plainTextOf(segs);
  const idx = plain.indexOf(p.span);
  if (idx < 0) {
    throw new Error(`span ${JSON.stringify(p.span)} not found verbatim in paragraph ${p.paraIndex}`);
  }

  let newSegs = applyTagRange(segs, idx, idx + p.span.length, p.tag);
  if (p.note) newSegs = attachNote(newSegs, p.span, p.tag, p.note);
  const newParagraph = serializeParagraph(newSegs);
  const blockId = block.blockId || blockIdFor(p.paraIndex);

  // Replace [start,end) — block.end spans the original `^id` too, so it is
  // dropped here and re-applied by ensureBlockId (which re-splits the new body).
  const before = strippedBody.slice(0, block.start);
  const after = strippedBody.slice(block.end);
  let body = before + newParagraph + after;
  body = ensureBlockId(body, p.paraIndex, blockId);
  return { body, blockId, paragraph: newParagraph };
}

// Attach `note=` to the first freshly-tagged segment matching the span. When a
// span crosses existing tag boundaries applyTagRange emits several tagged
// segments; we annotate the first, which is the common single-segment case.
function attachNote(segs: Segment[], span: string, tag: string, note: string): Segment[] {
  let done = false;
  return segs.map(s => {
    if (!done && s.tag === tag && s.text === span && !s.note) {
      done = true;
      return { ...s, note };
    }
    return s;
  });
}
