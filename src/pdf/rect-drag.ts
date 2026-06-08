// Tracks mousedown → mouseup drags on PDF pages so that, when there's no text
// to select (image-only PDFs, blank-margin areas), the user can still anchor a
// tag by drawing a rectangle. The rect is captured as a percentage of the
// page's current dimensions so the saved entry survives zoom changes.
//
// Module-level state is the simplest fit here: only one drag is in flight at a
// time, and the global document mousedown is already the cheapest hook.

export interface PdfRectAnchor {
  page: number;
  // All values are percentages of the page's current width/height (so zoom-
  // and resize-invariant). 0–100 each; width/height are clamped non-negative.
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
  // Viewport rect of the drag at mouseup — used to position the tagbar.
  viewportRect: { left: number; top: number; width: number; height: number };
}

interface DragStart {
  pageEl: HTMLElement;
  pageNumber: number;
  startClientX: number;
  startClientY: number;
}

let lastDragStart: DragStart | null = null;
let installed = false;

const MIN_DRAG_PX = 5;

// Install a single document-level mousedown listener that records where each
// drag began, so a later mouseup can recover the drag rect. Safe to call more
// than once; only the first call wires up.
export function installPdfRectDragTracking(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('mousedown', (e) => {
    const target = e.target as HTMLElement | null;
    const pageEl = target?.closest('.page[data-page-number]') as HTMLElement | null;
    if (!pageEl) {
      lastDragStart = null;
      return;
    }
    const num = parseInt(pageEl.getAttribute('data-page-number') || '0', 10);
    if (!num) { lastDragStart = null; return; }
    lastDragStart = {
      pageEl,
      pageNumber: num,
      startClientX: e.clientX,
      startClientY: e.clientY,
    };
  }, true);
}

// Try to recover a rect-drag from the last mousedown + this mouseup.
// Returns null if no drag was tracked, the drag was too short to count as
// rectangular intent, or the start/end didn't share a PDF page.
export function readPdfRectDrag(mouseup: MouseEvent): PdfRectAnchor | null {
  const start = lastDragStart;
  lastDragStart = null;
  if (!start) return null;

  const dx = mouseup.clientX - start.startClientX;
  const dy = mouseup.clientY - start.startClientY;
  if (Math.abs(dx) < MIN_DRAG_PX && Math.abs(dy) < MIN_DRAG_PX) return null;

  // The mouseup target must still be inside (or near) the same page. Cheap
  // sanity check: ensure the start pageEl is still in the document.
  if (!document.contains(start.pageEl)) return null;

  const pageRect = start.pageEl.getBoundingClientRect();
  if (!pageRect.width || !pageRect.height) return null;

  // Drag rect in viewport coords (normalize so width/height are positive).
  const vL = Math.min(start.startClientX, mouseup.clientX);
  const vT = Math.min(start.startClientY, mouseup.clientY);
  const vR = Math.max(start.startClientX, mouseup.clientX);
  const vB = Math.max(start.startClientY, mouseup.clientY);

  // Clamp to the page bounds — drags can spill past margins, but the saved
  // anchor should reference the actual page area only.
  const cL = Math.max(vL, pageRect.left);
  const cT = Math.max(vT, pageRect.top);
  const cR = Math.min(vR, pageRect.right);
  const cB = Math.min(vB, pageRect.bottom);
  if (cR <= cL || cB <= cT) return null;

  const leftPct   = ((cL - pageRect.left) / pageRect.width) * 100;
  const topPct    = ((cT - pageRect.top)  / pageRect.height) * 100;
  const widthPct  = ((cR - cL) / pageRect.width) * 100;
  const heightPct = ((cB - cT) / pageRect.height) * 100;

  return {
    page: start.pageNumber,
    leftPct,
    topPct,
    widthPct,
    heightPct,
    viewportRect: { left: cL, top: cT, width: cR - cL, height: cB - cT },
  };
}

// Parse a `&rect=L,T,W,H` fragment out of a stored wikilink. Returns null when
// the wikilink doesn't carry a rect anchor (e.g. text-anchored entries).
export function parseRectFromWikilink(wikilink: string): {
  leftPct: number; topPct: number; widthPct: number; heightPct: number;
} | null {
  const m = /[#&]rect=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(wikilink);
  if (!m) return null;
  return {
    leftPct: parseFloat(m[1]),
    topPct: parseFloat(m[2]),
    widthPct: parseFloat(m[3]),
    heightPct: parseFloat(m[4]),
  };
}

// Format the four percentages back into the wikilink fragment shape with a
// shared precision so the same rect always serializes identically (idempotent
// block-id hashing depends on this).
export function formatRectForWikilink(r: {
  leftPct: number; topPct: number; widthPct: number; heightPct: number;
}): string {
  const f = (n: number) => n.toFixed(2);
  return `${f(r.leftPct)},${f(r.topPct)},${f(r.widthPct)},${f(r.heightPct)}`;
}
