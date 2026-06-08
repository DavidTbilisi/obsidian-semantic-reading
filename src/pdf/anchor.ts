// Pure utilities for anchoring tagged spans inside an Obsidian PDF view.
//
// The PDF view renders pages with a `.page[data-page-number="N"]` container that
// contains a `.textLayer` of absolutely-positioned `<span>`s (PDF.js conventions).
// These helpers walk the DOM to recover (page, text, rect) without touching
// internal Obsidian APIs.

export interface PdfSelection {
  page: number;
  text: string;
  // Bounding rect in viewport coords — used to position the tagbar AND, in M3,
  // as a fallback anchor when no text could be extracted (image-only PDFs).
  rect: { left: number; top: number; width: number; height: number };
}

// Walk up from a DOM node to the enclosing `.page` and return its page number,
// or null if the node isn't inside a PDF page.
export function pageNumberFromNode(node: Node | null): number | null {
  let el: HTMLElement | null = node instanceof HTMLElement
    ? node
    : (node?.parentElement || null);
  while (el) {
    const n = el.getAttribute?.('data-page-number');
    if (n) {
      const parsed = parseInt(n, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    el = el.parentElement;
  }
  return null;
}

// Read the current window selection and resolve it to a PdfSelection if it
// falls inside a PDF page. Returns null when there's no usable selection.
export function readPdfSelection(): PdfSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const page = pageNumberFromNode(range.startContainer)
    ?? pageNumberFromNode(range.endContainer);
  if (page == null) return null;
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return {
    page,
    text,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  };
}

// Stable, deterministic block-id for a PDF span. Same (page, text) → same id,
// so re-tagging the exact selection is a no-op rather than a duplicate entry.
//
// 32-bit FNV-1a → 8 hex chars. Keep this independent of any vendored hash so
// we don't drag a dependency in for a single 10-line function.
export function stableBlockId(page: number, text: string): string {
  return `pdf-p${page}-${fnv1a32Hex(`${page}:${text}`)}`;
}

function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
