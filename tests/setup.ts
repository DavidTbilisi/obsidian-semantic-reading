// Polyfill Obsidian's HTMLElement prototype extensions so production code that
// calls `el.empty()`, `el.createDiv()`, etc. works under happy-dom. Obsidian's
// real implementation augments HTMLElement at runtime — we mirror the surface
// area the codebase actually touches.

type CreateOptions = {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string>;
  type?: string;
};

function applyOptions(el: HTMLElement, o?: CreateOptions): void {
  if (!o) return;
  if (o.cls) {
    const classes = Array.isArray(o.cls) ? o.cls : o.cls.split(/\s+/).filter(Boolean);
    classes.forEach(c => el.classList.add(c));
  }
  if (o.text != null) el.textContent = o.text;
  if (o.attr) {
    for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
  }
  if (o.type && el instanceof HTMLInputElement) el.type = o.type;
}

const proto = HTMLElement.prototype as any;

proto.empty = function (this: HTMLElement): void {
  while (this.firstChild) this.removeChild(this.firstChild);
};

proto.setText = function (this: HTMLElement, text: string): void {
  this.textContent = text;
};

proto.createEl = function (
  this: HTMLElement,
  tag: string,
  options?: CreateOptions,
): HTMLElement {
  const el = document.createElement(tag);
  applyOptions(el, options);
  this.appendChild(el);
  return el;
};

proto.createDiv = function (
  this: HTMLElement,
  options?: CreateOptions | string,
): HTMLElement {
  const opts = typeof options === 'string' ? { cls: options } : options;
  return proto.createEl.call(this, 'div', opts);
};

proto.createSpan = function (
  this: HTMLElement,
  options?: CreateOptions | string,
): HTMLElement {
  const opts = typeof options === 'string' ? { cls: options } : options;
  return proto.createEl.call(this, 'span', opts);
};
