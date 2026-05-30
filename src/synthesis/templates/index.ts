import { VaultIndex, Mention } from '../../graph/vault-index';

export interface TemplateArg {
  kind: 'concept' | 'note' | 'none';
  value?: string;
}

export interface TemplateSlice {
  body: string;             // markdown text fed to the LLM as the "vault slice"
  citations: Mention[];     // mentions referenced in the body (for provenance footer)
}

export interface SynthesisTemplate {
  id: string;
  name: string;
  description: string;
  arg: 'concept' | 'note' | 'none';
  buildSlice(idx: VaultIndex, arg?: string): TemplateSlice | null;
  buildInstruction(arg?: string): string;
}

function mentionLine(m: Mention): string {
  const link = `[[${m.notePath.replace(/\.md$/, '')}#^${m.blockId}]]`;
  return `- ${link} — ${truncate(m.text, 220)}`;
}
function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

const outline: SynthesisTemplate = {
  id: 'outline',
  name: 'Outline (Def → R → Ev)',
  description: 'Build a hierarchical outline for a concept from its definitions, relations, and evidence.',
  arg: 'concept',
  buildSlice(idx, arg) {
    if (!arg) return null;
    const concept = idx.concepts[arg];
    if (!concept) return null;
    const citations: Mention[] = [...concept.mentions];
    const noteSet = new Set(concept.mentions.map(m => m.notePath));
    const relations = (idx.byTag['R'] || []).filter(m => noteSet.has(m.notePath));
    const evidence = (idx.byTag['Ev'] || []).filter(m => noteSet.has(m.notePath));
    citations.push(...relations, ...evidence);
    const lines = [
      `## Concept: ${concept.display}`,
      '',
      '### Definitions',
      ...concept.mentions.map(mentionLine),
      '',
      '### Relations in the same notes',
      ...(relations.length ? relations.map(mentionLine) : ['- _none_']),
      '',
      '### Evidence in the same notes',
      ...(evidence.length ? evidence.map(mentionLine) : ['- _none_']),
    ];
    return { body: lines.join('\n'), citations };
  },
  buildInstruction(arg) {
    return [
      `Build a hierarchical outline of the concept "${arg}" using only the slice below.`,
      'Lead with the canonical definition, then group related claims by sub-topic.',
      'Use H2/H3 headers and bullet lists. Cite every claim with the wikilink given in the slice.',
    ].join(' ');
  },
};

const steelman: SynthesisTemplate = {
  id: 'steelman',
  name: 'Steelman (T / X / Opp / Assump)',
  description: 'Surface tensions, opposing views, tradeoffs, and unstated assumptions for a topic.',
  arg: 'concept',
  buildSlice(idx, arg) {
    if (!arg) return null;
    const concept = idx.concepts[arg];
    if (!concept) return null;
    const noteSet = new Set(concept.mentions.map(m => m.notePath));
    const T = (idx.byTag['T'] || []).filter(m => noteSet.has(m.notePath));
    const X = (idx.byTag['X'] || []).filter(m => noteSet.has(m.notePath));
    const Opp = (idx.byTag['Opp'] || []).filter(m => noteSet.has(m.notePath));
    const Assump = (idx.byTag['Assump'] || []).filter(m => noteSet.has(m.notePath));
    const citations = [...T, ...X, ...Opp, ...Assump];
    if (!citations.length) return null;
    const lines = [
      `## Steelman for: ${concept.display}`,
      '',
      '### Tradeoffs',
      ...(T.length ? T.map(mentionLine) : ['- _none_']),
      '',
      '### Tensions',
      ...(X.length ? X.map(mentionLine) : ['- _none_']),
      '',
      '### Opposing views',
      ...(Opp.length ? Opp.map(mentionLine) : ['- _none_']),
      '',
      '### Assumptions',
      ...(Assump.length ? Assump.map(mentionLine) : ['- _none_']),
    ];
    return { body: lines.join('\n'), citations };
  },
  buildInstruction(arg) {
    return [
      `Write a steelman of the position around "${arg}" that captures the strongest opposing case.`,
      'Use the tradeoffs, tensions, opposing views, and assumptions in the slice to construct it.',
      'Be specific and adversarial — do not soften the challenge. Cite each cited claim.',
    ].join(' ');
  },
};

const studyGuide: SynthesisTemplate = {
  id: 'study-guide',
  name: 'Study guide (Q + A + M)',
  description: 'Compose questions, the actions that answer them, and the measures of success.',
  arg: 'concept',
  buildSlice(idx, arg) {
    if (!arg) return null;
    const concept = idx.concepts[arg];
    if (!concept) return null;
    const noteSet = new Set(concept.mentions.map(m => m.notePath));
    const Q = (idx.byTag['Q'] || []).filter(m => noteSet.has(m.notePath));
    const A = (idx.byTag['A'] || []).filter(m => noteSet.has(m.notePath));
    const M = (idx.byTag['M'] || []).filter(m => noteSet.has(m.notePath));
    const citations = [...concept.mentions, ...Q, ...A, ...M];
    const lines = [
      `## Study guide: ${concept.display}`,
      '',
      '### Definitions to know',
      ...concept.mentions.map(mentionLine),
      '',
      '### Questions',
      ...(Q.length ? Q.map(mentionLine) : ['- _none_']),
      '',
      '### Actions',
      ...(A.length ? A.map(mentionLine) : ['- _none_']),
      '',
      '### Measures of success',
      ...(M.length ? M.map(mentionLine) : ['- _none_']),
    ];
    return { body: lines.join('\n'), citations };
  },
  buildInstruction(arg) {
    return [
      `Produce a study guide for the topic "${arg}".`,
      'Structure it as: 1) key terms with one-sentence definitions, 2) self-test questions with hints,',
      '3) what to do (actions), 4) how to verify (measures). Cite every claim.',
    ].join(' ');
  },
};

const briefing: SynthesisTemplate = {
  id: 'briefing',
  name: 'Briefing (N + D + P + key Defs + Q)',
  description: 'A one-pager: who, when, where, what, and the open questions.',
  arg: 'concept',
  buildSlice(idx, arg) {
    if (!arg) return null;
    const concept = idx.concepts[arg];
    if (!concept) return null;
    const noteSet = new Set(concept.mentions.map(m => m.notePath));
    const N = (idx.byTag['N'] || []).filter(m => noteSet.has(m.notePath));
    const D = (idx.byTag['D'] || []).filter(m => noteSet.has(m.notePath));
    const P = (idx.byTag['P'] || []).filter(m => noteSet.has(m.notePath));
    const Q = (idx.byTag['Q'] || []).filter(m => noteSet.has(m.notePath));
    const citations = [...concept.mentions, ...N, ...D, ...P, ...Q];
    const lines = [
      `## Briefing: ${concept.display}`,
      '',
      '### What it is',
      ...concept.mentions.map(mentionLine),
      '',
      '### Who',
      ...(N.length ? N.map(mentionLine) : ['- _none_']),
      '',
      '### When',
      ...(D.length ? D.map(mentionLine) : ['- _none_']),
      '',
      '### Where',
      ...(P.length ? P.map(mentionLine) : ['- _none_']),
      '',
      '### Open questions',
      ...(Q.length ? Q.map(mentionLine) : ['- _none_']),
    ];
    return { body: lines.join('\n'), citations };
  },
  buildInstruction(arg) {
    return [
      `Write a one-page briefing on "${arg}" suitable for someone with 5 minutes.`,
      'Use the slice. Lead with the canonical definition. Surface who/when/where, then the open questions.',
      'Cite every claim and link back to the source paragraphs.',
    ].join(' ');
  },
};

const agenda: SynthesisTemplate = {
  id: 'reading-agenda',
  name: 'Reading agenda (global open Qs)',
  description: 'Rank the open questions across the vault and propose what to read next.',
  arg: 'none',
  buildSlice(idx) {
    const Q = idx.byTag['Q'] || [];
    if (!Q.length) return null;
    const byNote = new Map<string, Mention[]>();
    for (const q of Q) {
      const list = byNote.get(q.notePath) || [];
      list.push(q);
      byNote.set(q.notePath, list);
    }
    const lines: string[] = [`## Open questions across the vault (${Q.length})`, ''];
    for (const [notePath, list] of byNote.entries()) {
      lines.push(`### [[${notePath.replace(/\.md$/, '')}]]`);
      list.forEach(q => lines.push(mentionLine(q)));
      lines.push('');
    }
    return { body: lines.join('\n'), citations: Q };
  },
  buildInstruction() {
    return [
      'Rank the open questions in the slice by how much follow-up reading they would unlock.',
      'For each, propose 1–2 specific next steps (which note to revisit, what to look up).',
      'Group by topic where possible. Cite every question with its source link.',
    ].join(' ');
  },
};

export const TEMPLATES: SynthesisTemplate[] = [outline, steelman, studyGuide, briefing, agenda];

export function findTemplate(id: string): SynthesisTemplate | undefined {
  return TEMPLATES.find(t => t.id === id);
}
