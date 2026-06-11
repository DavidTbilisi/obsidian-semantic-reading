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

// Obsidian injects `activeDocument` / `activeWindow` globals that resolve to the
// currently-focused window (so plugins work inside pop-out windows). happy-dom
// has no such globals — mirror them onto the test document/window so production
// code that reads them doesn't throw under test.
const globalScope = globalThis as unknown as { activeDocument?: Document; activeWindow?: Window };
if (typeof globalScope.activeDocument === 'undefined') globalScope.activeDocument = document;
if (typeof globalScope.activeWindow === 'undefined') globalScope.activeWindow = window;

const proto = HTMLElement.prototype as any;

proto.empty = function (this: HTMLElement): void {
  while (this.firstChild) this.removeChild(this.firstChild);
};

// Obsidian's class-list helpers (variadic add/remove, single-class hasClass).
proto.addClass = function (this: HTMLElement, ...classes: string[]): void {
  classes.forEach(c => this.classList.add(c));
};

proto.removeClass = function (this: HTMLElement, ...classes: string[]): void {
  classes.forEach(c => this.classList.remove(c));
};

proto.toggleClass = function (this: HTMLElement, classes: string | string[], value: boolean): void {
  const list = Array.isArray(classes) ? classes : [classes];
  list.forEach(c => this.classList.toggle(c, value));
};

proto.hasClass = function (this: HTMLElement, cls: string): boolean {
  return this.classList.contains(cls);
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
