// Minimal obsidian module mock — only the surface area our tests touch.
// Tagbar uses `Editor` and `MarkdownView` purely as TS types in signatures,
// so empty classes are enough at runtime.

export class Editor {}
export class MarkdownView {
  editor: any;
  contentEl!: HTMLElement;
}
