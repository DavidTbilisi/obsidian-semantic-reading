// Cursor pagination for MCP list methods (tools/list, resources/list,
// prompts/list). Per the spec the cursor is an opaque string the client must
// not interpret — we use a plain decimal offset, which keeps it debuggable
// while staying dependency-free (no Buffer / base64).

export const DEFAULT_PAGE_SIZE = 100;

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Slice `items` from the offset encoded in `cursor`. Emits a `nextCursor` only
// when more items remain, so a client loops until `nextCursor` is absent.
export function paginate<T>(items: T[], cursor: string | undefined, pageSize = DEFAULT_PAGE_SIZE): Page<T> {
  const start = decodeCursor(cursor);
  const slice = items.slice(start, start + pageSize);
  const end = start + slice.length;
  const page: Page<T> = { items: slice };
  if (end < items.length) page.nextCursor = String(end);
  return page;
}
