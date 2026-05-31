// Domain profiles let a note declare a per-note tag toolkit via
// `semantic_domain: <name>` in frontmatter. Each profile bundles a set of
// CustomTagDef entries plus a merge mode that controls how the bundle
// interacts with the universal built-in and user-custom tags.
//
// Reuses CustomTagDef so domain tags feed through the same color-injection,
// tagbar, and frontmatter-portability code paths as user customs.

import { CustomTagDef } from './custom-tags';
import { BUILTIN_TAGS, TagDef } from './constants';

export type DomainMergeMode = 'add' | 'replace' | 'subset';

export interface DomainProfile {
  name: string;                  // matches semantic_domain in frontmatter
  label: string;                 // human label for settings UI
  mergeMode: DomainMergeMode;
  keepBuiltins?: string[];       // for mergeMode === 'subset'
  tags: CustomTagDef[];          // tags this profile adds
  defaultMode?: number;          // optional 1..5 override when domain active
  disabled?: boolean;            // user-disabled in settings
}

export function findDomain(profiles: DomainProfile[], name: string | null | undefined): DomainProfile | null {
  if (!name) return null;
  const hit = profiles.find(p => p.name === name && !p.disabled);
  return hit || null;
}

// Compute the effective TAGS dictionary for an (optional) active domain.
// Pure function — does not touch the global registries in constants.ts.
//
// - `add`: builtins ∪ universal customs ∪ domain tags
// - `subset`: only the listed `keepBuiltins` + domain tags
// - `replace`: only domain tags
export function resolveTagsFor(
  domain: DomainProfile | null,
  universalCustoms: CustomTagDef[],
): Record<string, TagDef> {
  const out: Record<string, TagDef> = {};

  if (!domain || domain.mergeMode === 'add') {
    Object.assign(out, BUILTIN_TAGS);
    addCustomsTo(out, universalCustoms);
  } else if (domain.mergeMode === 'subset') {
    for (const sigil of domain.keepBuiltins || []) {
      if (BUILTIN_TAGS[sigil]) out[sigil] = BUILTIN_TAGS[sigil];
    }
  }
  // 'replace' starts from nothing

  if (domain) addCustomsTo(out, domain.tags);
  return out;
}

function addCustomsTo(out: Record<string, TagDef>, customs: CustomTagDef[]): void {
  for (const t of customs || []) {
    out[t.sigil] = {
      name: t.name,
      family: t.family,
      desc: t.desc || '',
      route: t.route || '*',
      parent: t.parent,
    };
  }
}
