export type FamilyName = 'Anchor' | 'Meaning' | 'Structure' | 'Execution';
export type RouteName = 'NEDF' | 'CAST' | 'SPEAR' | 'HEART' | 'ORACLE' | 'GRACE' | '*';

export interface TagDef {
  name: string;
  family: FamilyName;
  desc: string;
  route: RouteName;
  parent?: string;
}

export const TAGS: Record<string, TagDef> = {
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

export const MODES: Record<number, ModeDef> = {
  1: { name: 'Easy',         desc: 'stop reading passively, surface obvious anchors',  tags: ['Def','Ex','A','Q','N','D','P'] },
  2: { name: 'Functional',   desc: 'separate information by role, not just content',   tags: ['Def','Ex','R','Ev','A','Q','M'] },
  3: { name: 'Structural',   desc: 'make local structure visible',                     tags: ['Def','Mn','Ex','An','R','Ev','A','Q','M','C','B','L'] },
  4: { name: 'Systems',      desc: 'perceive the structure the author does not state', tags: ['Def','Mn','Ex','An','R','Ev','A','Q','M','C','B','L','Assump','X','Opp','T'] },
  5: { name: 'Regenerative', desc: 'reconstruct the chapter from structure',           tags: ['Def','Mn','Ex','An','R','Ev','A','Q','M','C','B','L','Assump','X','Opp','T','N','D','P'] },
};

export const FAMILIES: FamilyName[] = ['Anchor', 'Meaning', 'Structure', 'Execution'];

export const CARD_GROUPS: { label: string; tags: string[] }[] = [
  { label: 'Concepts',               tags: ['Def','Mn','Ex','An'] },
  { label: 'Relations & evidence',   tags: ['R','Ev'] },
  { label: 'Limits & delays',        tags: ['C','B','L'] },
  { label: 'Tensions & assumptions', tags: ['T','X','Opp','Assump'] },
  { label: 'Questions',              tags: ['Q'] },
  { label: 'Actions',                tags: ['A'] },
  { label: 'Measures',               tags: ['M'] },
  { label: 'Anchors',                tags: ['N','D','P'] },
];

// Letter → tag shortcut map, identical to the existing app's keymap (utils.js).
export const KEY_TO_TAG: Record<string, string> = {
  d: 'Def', q: 'Q', r: 'R', m: 'M', a: 'A', c: 'C', b: 'B', l: 'L',
  t: 'T',   x: 'X', n: 'N', p: 'P', w: 'D', s: 'Assump',
  e: 'Ev',  g: 'Ex', i: 'Mn', y: 'An', o: 'Opp',
};

export function tagForKey(key: string): string | null {
  return KEY_TO_TAG[key.toLowerCase()] || null;
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
