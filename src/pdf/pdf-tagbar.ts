// Glue between an Obsidian PDF view and the existing Tagbar.
//
// On mouseup over a PDF view we read the current selection, identify the page,
// position the tagbar at the selection rect, and wire its commit callback to
// the sidecar writer. The Tagbar itself stays surface-agnostic.

import { App, Notice, TFile } from 'obsidian';
import { Tagbar } from '../editor/tagbar';
import { PdfSelection, readPdfSelection, stableBlockId } from './anchor';
import { appendEntry } from './sidecar';
import { PdfRectAnchor, formatRectForWikilink, readPdfRectDrag } from './rect-drag';

interface PdfLikeView {
  file?: TFile | null;
  getViewType(): string;
  contentEl?: HTMLElement;
  containerEl?: HTMLElement;
}

export function isPdfView(view: unknown): view is PdfLikeView {
  return !!view
    && typeof (view as PdfLikeView).getViewType === 'function'
    && (view as PdfLikeView).getViewType() === 'pdf';
}

// Try to show the tagbar for the current PDF selection. Returns true when a
// selection (or, as fallback for image PDFs, a drag-rect) was found and the
// tagbar was shown; false when there's nothing to tag.
export function showTagbarForPdf(
  app: App,
  tagbar: Tagbar,
  view: PdfLikeView,
  mouseup?: MouseEvent,
): boolean {
  const file = view.file;
  if (!file || file.extension.toLowerCase() !== 'pdf') return false;
  const pdfPath = file.path;
  const pane = view.containerEl ?? view.contentEl;

  const selection = readPdfSelection();
  if (selection) {
    showForText(app, tagbar, pdfPath, selection, pane);
    return true;
  }

  // No text selected — fall back to rect-drag if the mouseup followed a drag.
  if (mouseup) {
    const rectAnchor = readPdfRectDrag(mouseup);
    if (rectAnchor) {
      showForRect(app, tagbar, pdfPath, rectAnchor, pane);
      return true;
    }
  }
  return false;
}

function showForText(
  app: App,
  tagbar: Tagbar,
  pdfPath: string,
  selection: PdfSelection,
  pane: HTMLElement | undefined,
): void {
  const { page, text, rect } = selection;
  const blockId = stableBlockId(page, text);
  tagbar.showWithCommit(
    rect.left + rect.width / 2,
    rect.top,
    async (tag) => {
      try {
        const result = await appendEntry(app, {
          kind: 'text', pdfPath, page, text, tag, blockId,
        });
        if (result === 'skipped') new Notice(`Already tagged: ${tag} on page ${page}`);
      } catch (err) {
        console.error('sr: failed to write PDF sidecar', err);
        new Notice(`Failed to save PDF annotation: ${(err as Error).message}`);
      }
    },
    pane,
  );
}

function showForRect(
  app: App,
  tagbar: Tagbar,
  pdfPath: string,
  anchor: PdfRectAnchor,
  pane: HTMLElement | undefined,
): void {
  const { page, viewportRect } = anchor;
  // Hash on the rect string (same precision used at write time) so re-dragging
  // the exact same area is idempotent.
  const rectStr = formatRectForWikilink(anchor);
  const blockId = stableBlockId(page, 'rect:' + rectStr);
  tagbar.showWithCommit(
    viewportRect.left + viewportRect.width / 2,
    viewportRect.top,
    async (tag) => {
      try {
        const result = await appendEntry(app, {
          kind: 'rect',
          pdfPath,
          page,
          rect: {
            leftPct: anchor.leftPct,
            topPct: anchor.topPct,
            widthPct: anchor.widthPct,
            heightPct: anchor.heightPct,
          },
          tag,
          blockId,
        });
        if (result === 'skipped') new Notice(`Region already tagged: ${tag} on page ${page}`);
      } catch (err) {
        console.error('sr: failed to write PDF sidecar (rect)', err);
        new Notice(`Failed to save PDF annotation: ${(err as Error).message}`);
      }
    },
    pane,
  );
}
