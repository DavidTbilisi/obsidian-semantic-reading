import {
  BUILTIN_KEY_TO_TAG,
  BUILTIN_TAGS,
  FamilyName,
  KEY_TO_TAG,
  MODES,
  RouteName,
  TAGS,
  resetRegistries,
} from './constants';

export interface CustomTagDef {
  sigil: string;
  name: string;
  family: FamilyName;
  desc: string;
  route?: RouteName;
  parent?: string;
  keyBinding?: string;
  light?: string;
  dark?: string;
  inModes?: number[];
}

const SIGIL_RE = /^[A-Za-z][A-Za-z0-9]{0,11}$/;

export function validateSigil(s: string): string | null {
  if (!s) return 'Sigil is required';
  if (!SIGIL_RE.test(s)) return 'Sigil must start with a letter (1–12 alphanumerics)';
  if (BUILTIN_TAGS[s]) return `"${s}" is a built-in tag — pick another sigil`;
  return null;
}

export function validateCustomTag(t: CustomTagDef, others: CustomTagDef[]): string | null {
  const sigErr = validateSigil(t.sigil);
  if (sigErr) return sigErr;
  if (others.some(o => o !== t && o.sigil === t.sigil)) return `Duplicate sigil "${t.sigil}"`;
  if (!t.name?.trim()) return 'Name is required';
  if (t.keyBinding && t.keyBinding.length !== 1) return 'Key binding must be a single character';
  if (t.parent && !TAGS[t.parent] && !others.some(o => o.sigil === t.parent)) {
    return `Parent "${t.parent}" does not exist`;
  }
  return null;
}

// Re-apply the custom-tag overlay: reset the runtime registries to built-ins,
// then merge each custom tag into TAGS, push it into the requested modes, and
// bind its key. Existing built-in key bindings always win — a custom binding
// only applies if the key is currently free.
export function applyCustomTags(custom: CustomTagDef[]): void {
  resetRegistries();
  for (const t of custom || []) {
    if (validateSigil(t.sigil)) continue;
    TAGS[t.sigil] = {
      name: t.name,
      family: t.family,
      desc: t.desc || '',
      route: t.route || '*',
      parent: t.parent,
    };
    const modes = t.inModes && t.inModes.length ? t.inModes : [1, 2, 3, 4, 5];
    for (const m of modes) {
      const md = MODES[m];
      if (md && !md.tags.includes(t.sigil)) md.tags.push(t.sigil);
    }
    if (t.keyBinding) {
      const k = t.keyBinding.toLowerCase();
      if (!BUILTIN_KEY_TO_TAG[k]) KEY_TO_TAG[k] = t.sigil;
    }
  }
}

const STYLE_ID = 'sr-custom-tag-colors';

// Inject (or replace) a single <style> element containing color variables for
// every custom tag. Idempotent — call after applyCustomTags() and any time
// custom colors change.
export function injectCustomTagCSS(custom: CustomTagDef[]): void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  const lines: string[] = [];
  const lightVars: string[] = [];
  const darkVars: string[] = [];
  const classes: string[] = [];
  for (const t of custom || []) {
    if (validateSigil(t.sigil)) continue;
    const light = t.light || '#6c6c6c';
    const dark = t.dark || '#bdbdbd';
    lightVars.push(`  --t-${t.sigil}: ${light};`);
    darkVars.push(`  --t-${t.sigil}: ${dark};`);
    classes.push(`.sr-tg-${t.sigil} { color: var(--t-${t.sigil}); }`);
  }
  if (lightVars.length) lines.push('.theme-light {\n' + lightVars.join('\n') + '\n}');
  if (darkVars.length) lines.push('.theme-dark {\n' + darkVars.join('\n') + '\n}');
  if (classes.length) lines.push(classes.join('\n'));
  el.textContent = lines.join('\n\n');
}

// === Frontmatter portability ===
//
// When a note uses a custom tag, we write a `semantic_tags_def` block into its
// frontmatter so the note carries its taxonomy with it. A reader on another
// vault can use "Import custom tags from current note" to add the defs to
// their own settings.

export function customTagsUsedIn(usedSigils: Iterable<string>, custom: CustomTagDef[]): CustomTagDef[] {
  const set = new Set(usedSigils);
  return (custom || []).filter(t => set.has(t.sigil));
}

export function serializeForFrontmatter(used: CustomTagDef[]): Record<string, unknown>[] {
  return used.map(t => {
    const out: Record<string, unknown> = {
      sigil: t.sigil,
      name: t.name,
      family: t.family,
      desc: t.desc || '',
    };
    if (t.route && t.route !== '*') out.route = t.route;
    if (t.parent) out.parent = t.parent;
    if (t.keyBinding) out.key = t.keyBinding;
    if (t.light) out.light = t.light;
    if (t.dark) out.dark = t.dark;
    return out;
  });
}

export function parseFromFrontmatter(raw: unknown): CustomTagDef[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomTagDef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    const sigil = typeof r.sigil === 'string' ? r.sigil : '';
    const name = typeof r.name === 'string' ? r.name : '';
    const family = typeof r.family === 'string' ? (r.family as FamilyName) : 'Structure';
    if (!sigil || !name) continue;
    out.push({
      sigil,
      name,
      family,
      desc: typeof r.desc === 'string' ? r.desc : '',
      route: typeof r.route === 'string' ? (r.route as RouteName) : '*',
      parent: typeof r.parent === 'string' ? r.parent : undefined,
      keyBinding: typeof r.key === 'string' ? r.key : undefined,
      light: typeof r.light === 'string' ? r.light : undefined,
      dark: typeof r.dark === 'string' ? r.dark : undefined,
    });
  }
  return out;
}

export function mergeImported(existing: CustomTagDef[], incoming: CustomTagDef[]): { merged: CustomTagDef[]; added: number; skipped: number } {
  const known = new Set(existing.map(t => t.sigil));
  let added = 0;
  let skipped = 0;
  const merged = [...existing];
  for (const t of incoming) {
    if (validateSigil(t.sigil)) { skipped++; continue; }
    if (known.has(t.sigil)) { skipped++; continue; }
    merged.push(t);
    known.add(t.sigil);
    added++;
  }
  return { merged, added, skipped };
}
