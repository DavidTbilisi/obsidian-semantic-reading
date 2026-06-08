export type FamilyName = 'Anchor' | 'Meaning' | 'Structure' | 'Execution' | 'Language';
export type RouteName = 'NEDF' | 'CAST' | 'SPEAR' | 'HEART' | 'ORACLE' | 'GRACE' | '*';

export interface TagDef {
  name: string;
  family: FamilyName;
  desc: string;
  route: RouteName;
  parent?: string;
}

export const BUILTIN_TAGS: Record<string, TagDef> = {
  N:      { name: 'Name',          family: 'Anchor',    desc: 'people / things / titles',                    route: 'HEART' },
  D:      { name: 'Date',          family: 'Anchor',    desc: 'when something happened',                     route: 'CAST'  },
  P:      { name: 'Place',         family: 'Anchor',    desc: 'where something happened',                    route: 'CAST'  },
  Def:    { name: 'Definition',    family: 'Meaning',   desc: 'concept identity',                            route: 'NEDF'  },
  Mn:     { name: 'Meaning',       family: 'Meaning',   desc: 'what the concept means here',                 route: 'NEDF', parent: 'Def' },
  Ex:     { name: 'Example',       family: 'Meaning',   desc: 'concrete instance of a concept',              route: 'NEDF', parent: 'Def' },
  An:     { name: 'Analogy',       family: 'Meaning',   desc: 'comparison that clarifies',                   route: 'NEDF', parent: 'Def' },
  Q:      { name: 'Question',      family: 'Meaning',   desc: 'what is unclear',                             route: '*'     },
  R:      { name: 'Relation',      family: 'Structure', desc: 'X causes / supports / depends on Y',          route: 'CAST'  },
  Ev:     { name: 'Evidence',      family: 'Structure', desc: 'data / case that supports a relation',        route: 'CAST', parent: 'R' },
  C:      { name: 'Constraint',    family: 'Structure', desc: 'limit on the system',                         route: 'SPEAR' },
  B:      { name: 'Bottleneck',    family: 'Structure', desc: 'choke point',                                 route: 'SPEAR' },
  L:      { name: 'Delay',         family: 'Structure', desc: 'effect appears later',                        route: 'CAST'  },
  T:      { name: 'Tradeoff',      family: 'Structure', desc: 'gain X vs lose Y',                            route: 'CAST'  },
  X:      { name: 'Tension',       family: 'Structure', desc: 'contradiction or conflict',                   route: 'CAST'  },
  Opp:    { name: 'Opposite view', family: 'Structure', desc: 'alternative / opposing stance',               route: 'CAST', parent: 'X' },
  Assump: { name: 'Assumption',    family: 'Structure', desc: 'unstated requirement',                        route: 'CAST'  },
  A:      { name: 'Action',        family: 'Execution', desc: 'what to do (method / procedure step)',        route: 'SPEAR' },
  M:      { name: 'Measure',       family: 'Execution', desc: 'how to know it worked (signal / prediction)', route: 'ORACLE' },
  // Language family — vocabulary atoms (L2/Gloss/Sound/Pattern) and listening-miss
  // signals (Miss*). Surfaced in the AI tag-suggestion prompt only when a note
  // carries `language: <code>` frontmatter. See src/ai/prompts.ts.
  L2:      { name: 'L2 span',        family: 'Language', desc: 'target-language word or phrase (card anchor)', route: 'NEDF'   },
  Gloss:   { name: 'Gloss',          family: 'Language', desc: 'L1 meaning of an L2 span',                     route: 'NEDF', parent: 'L2' },
  Pron:    { name: 'Pronunciation',  family: 'Language', desc: 'pronunciation / IPA for an L2 span',           route: 'NEDF', parent: 'L2' },
  Pattern: { name: 'Pattern',        family: 'Language', desc: 'reusable grammar pattern instance',            route: 'NEDF'   },
  MissSnd: { name: 'Miss — sound',   family: 'Language', desc: 'heard but could not decode',                   route: 'ORACLE' },
  MissWrd: { name: 'Miss — word',    family: 'Language', desc: 'decoded but did not know',                     route: 'ORACLE' },
  MissGrm: { name: 'Miss — grammar', family: 'Language', desc: 'knew words but missed structure',              route: 'ORACLE' },
  MissPrg: { name: 'Miss — pragma',  family: 'Language', desc: 'decoded literal but missed intent',            route: 'ORACLE' },
};

export const FRAMEWORKS: Record<string, { name: string; desc: string }> = {
  NEDF:   { name: 'NEDF',   desc: 'concepts'           },
  CAST:   { name: 'CAST',   desc: 'graphs / relations' },
  SPEAR:  { name: 'SPEAR',  desc: 'procedures'         },
  HEART:  { name: 'HEART',  desc: 'people'             },
  ORACLE: { name: 'ORACLE', desc: 'prediction'         },
  GRACE:  { name: 'GRACE',  desc: 'social-pragmatic'   },
};
export const FRAMEWORK_ORDER: RouteName[] = ['NEDF', 'CAST', 'SPEAR', 'HEART', 'ORACLE', 'GRACE'];

export interface ModeDef {
  name: string;
  desc: string;
  tags: string[];
}

export const BUILTIN_MODES: Record<number, ModeDef> = {
  1: { name: 'Easy',         desc: 'stop reading passively, surface obvious anchors',  tags: ['Def','Ex','A','Q','N','D','P'] },
  2: { name: 'Functional',   desc: 'separate information by role, not just content',   tags: ['Def','Ex','R','Ev','A','Q','M','L2','Gloss'] },
  3: { name: 'Structural',   desc: 'make local structure visible',                     tags: ['Def','Mn','Ex','An','R','Ev','A','Q','M','C','B','L','L2','Gloss','Pron','Pattern'] },
  4: { name: 'Systems',      desc: 'perceive the structure the author does not state', tags: ['Def','Mn','Ex','An','R','Ev','A','Q','M','C','B','L','Assump','X','Opp','T','L2','Gloss','Pron','Pattern','MissSnd','MissWrd','MissGrm','MissPrg'] },
  5: { name: 'Regenerative', desc: 'reconstruct the chapter from structure',           tags: ['Def','Mn','Ex','An','R','Ev','A','Q','M','C','B','L','Assump','X','Opp','T','N','D','P','L2','Gloss','Pron','Pattern','MissSnd','MissWrd','MissGrm','MissPrg'] },
};

export const FAMILIES: FamilyName[] = ['Anchor', 'Meaning', 'Structure', 'Execution', 'Language'];

// Language-family sigil sets. Card-builder reads LANGUAGE_CARD_TAGS to decide
// which L2 sigils anchor a flashcard; AI prompt + Miss-histogram emission read
// LANGUAGE_TAGS / LANGUAGE_MISS_TAGS. Kept here so all language-aware code
// shares one source of truth.
export const LANGUAGE_TAGS = ['L2', 'Gloss', 'Pron', 'Pattern', 'MissSnd', 'MissWrd', 'MissGrm', 'MissPrg'] as const;
export const LANGUAGE_CARD_TAGS = new Set<string>(['L2', 'Pattern']);
export const LANGUAGE_MISS_TAGS = ['MissSnd', 'MissWrd', 'MissGrm', 'MissPrg'] as const;

export const CARD_GROUPS: { label: string; tags: string[] }[] = [
  { label: 'Concepts',               tags: ['Def','Mn','Ex','An'] },
  { label: 'Relations & evidence',   tags: ['R','Ev'] },
  { label: 'Limits & delays',        tags: ['C','B','L'] },
  { label: 'Tensions & assumptions', tags: ['T','X','Opp','Assump'] },
  { label: 'Questions',              tags: ['Q'] },
  { label: 'Actions',                tags: ['A'] },
  { label: 'Measures',               tags: ['M'] },
  { label: 'Anchors',                tags: ['N','D','P'] },
  { label: 'Language',               tags: ['L2','Gloss','Pron','Pattern','MissSnd','MissWrd','MissGrm','MissPrg'] },
];

// Letter → tag shortcut map, identical to the existing app's keymap (utils.js).
export const BUILTIN_KEY_TO_TAG: Record<string, string> = {
  d: 'Def', q: 'Q', r: 'R', m: 'M', a: 'A', c: 'C', b: 'B', l: 'L',
  t: 'T',   x: 'X', n: 'N', p: 'P', w: 'D', s: 'Assump',
  e: 'Ev',  g: 'Ex', i: 'Mn', y: 'An', o: 'Opp',
};

// Mutable working copies — initialized from the BUILTIN_* baselines, then
// extended at runtime by applyCustomTags() in src/custom-tags.ts. Consumers
// import these and read from them as plain dictionaries; mutating in place
// means everyone picks up custom-tag overlays without a refactor.
export const TAGS: Record<string, TagDef> = { ...BUILTIN_TAGS };
export const MODES: Record<number, ModeDef> = cloneModes(BUILTIN_MODES);
export const KEY_TO_TAG: Record<string, string> = { ...BUILTIN_KEY_TO_TAG };

function cloneModes(src: Record<number, ModeDef>): Record<number, ModeDef> {
  const out: Record<number, ModeDef> = {};
  for (const k of Object.keys(src)) {
    const n = Number(k);
    out[n] = { ...src[n], tags: [...src[n].tags] };
  }
  return out;
}

// Reset TAGS/MODES/KEY_TO_TAG back to the built-in baseline. Called by
// applyCustomTags() before re-applying overlays.
export function resetRegistries(): void {
  for (const k of Object.keys(TAGS)) delete TAGS[k];
  Object.assign(TAGS, BUILTIN_TAGS);
  for (const k of Object.keys(MODES)) delete (MODES as Record<string, unknown>)[k];
  Object.assign(MODES, cloneModes(BUILTIN_MODES));
  for (const k of Object.keys(KEY_TO_TAG)) delete KEY_TO_TAG[k];
  Object.assign(KEY_TO_TAG, BUILTIN_KEY_TO_TAG);
}

export function tagForKey(key: string): string | null {
  return KEY_TO_TAG[key.toLowerCase()] || null;
}

// Apply user key-binding overrides on top of whatever is currently in
// KEY_TO_TAG (built-ins plus any custom-tag bindings). Each entry maps a single
// letter to a tag sigil; non-existent sigils are skipped. Unlike the custom-tag
// flow, user overrides DO shadow built-in bindings — that's the whole point.
export function applyKeyBindingOverrides(overrides: Record<string, string>): void {
  if (!overrides) return;
  for (const rawKey of Object.keys(overrides)) {
    const k = rawKey.toLowerCase();
    if (k.length !== 1) continue;
    const sigil = overrides[rawKey];
    if (!sigil) { delete KEY_TO_TAG[k]; continue; }
    if (!TAGS[sigil]) continue;
    KEY_TO_TAG[k] = sigil;
  }
}

// Returns tag keys ordered so each parent is followed by its children.
export function tagOrder(filterFn?: (k: string) => boolean): string[] {
  const keys = Object.keys(TAGS).filter(filterFn || (() => true));
  const present: Record<string, boolean> = {};
  keys.forEach(k => { present[k] = true; });
  const out: string[] = [];
  keys.forEach(k => {
    const t = TAGS[k];
    if (t.parent && present[t.parent]) return;
    out.push(k);
    keys.forEach(c => {
      if (TAGS[c].parent === k) out.push(c);
    });
  });
  return out;
}

export function cssTag(t: string): string {
  return t.replace(/[^A-Za-z0-9]/g, '');
}
