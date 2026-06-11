import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { MARK_REGEX } from '../syntax';
import { cssTag } from '../constants';

// A small <sup> widget appended after the tagged text, e.g. "Def".
class TagLabelWidget extends WidgetType {
  constructor(readonly tag: string) {
    super();
  }
  toDOM(): HTMLElement {
    const sup = activeDocument.createElement('sup');
    sup.className = 'sr-tlabel';
    sup.textContent = this.tag;
    sup.setAttr('aria-hidden', 'true');
    return sup;
  }
  eq(other: TagLabelWidget): boolean { return other.tag === this.tag; }
  ignoreEvent(): boolean { return false; }
}

// Builds decorations: hides delimiters when the cursor is off the line, marks the
// text portion with a tag class, and inserts a small superscript label widget.
function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const cursors = view.state.selection.ranges;

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const re = new RegExp(MARK_REGEX.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const tag = m[1];
      const body = m[2];
      const note = m[3];
      const matchStart = from + m.index;
      const matchEnd = matchStart + m[0].length;

      // Compute character positions for each segment of the syntax.
      const prefix = '{{' + tag + '|';
      const textStart = matchStart + prefix.length;
      const textEnd = textStart + body.length;

      // Show full source if the cursor / selection touches this match.
      const cursorTouches = cursors.some(r => !(r.to < matchStart || r.from > matchEnd));

      if (cursorTouches) {
        // Just mark the body text with the tag color so it's still distinguishable.
        builder.add(
          textStart,
          textEnd,
          Decoration.mark({ class: 'sr-tspan sr-tg-' + cssTag(tag) })
        );
      } else {
        // Hide the `{{Tag|` prefix.
        builder.add(matchStart, textStart, Decoration.replace({}));
        // Mark the text body.
        builder.add(
          textStart,
          textEnd,
          Decoration.mark({
            class: 'sr-tspan sr-tg-' + cssTag(tag) + (note ? ' sr-has-note' : ''),
            attributes: note ? { title: note } : undefined,
          })
        );
        // Hide the trailing `}}` (and optional `|note=...`).
        builder.add(textEnd, matchEnd, Decoration.replace({
          widget: new TagLabelWidget(tag),
        }));
      }
    }
  }
  return builder.finish();
}

export const semanticReadingExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: v => v.decorations }
);
