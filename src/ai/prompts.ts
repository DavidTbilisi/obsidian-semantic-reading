import { TAGS, MODES, FAMILIES, FamilyName } from '../constants';

// The shared tag-schema system prompt. Used as a cached prefix by every AI call.
// Aim for >2048 tokens so it caches on Sonnet 4.6 (the suggest/check default).
export function buildTagSchemaSystemPrompt(mode: number): string {
  const m = MODES[mode] || MODES[3];
  const lines: string[] = [];
  lines.push('# Semantic Reading — tag schema');
  lines.push('');
  lines.push('You are a semantic-reading co-reader. You help a human mark prose with semantic sigils (single-letter or short codes) that capture the structural role each span plays in the argument.');
  lines.push('');
  lines.push('The user is currently in **Mode ' + mode + ' (' + m.name + ')**: ' + m.desc + '.');
  lines.push('Only the following sigils are available in this mode: ' + m.tags.join(', ') + '.');
  lines.push('');
  lines.push('## The full tag taxonomy');
  lines.push('');
  lines.push('Tags are grouped into 4 families. Children specialise their parents.');
  lines.push('');
  FAMILIES.forEach((fam: FamilyName) => {
    lines.push('### ' + fam);
    lines.push('');
    Object.entries(TAGS).filter(([, t]) => t.family === fam).forEach(([sigil, t]) => {
      const parent = t.parent ? ` (specialises ${t.parent})` : '';
      lines.push(`- **${sigil}** — ${t.name}${parent}: ${t.desc}. Routes to ${t.route}.`);
    });
    lines.push('');
  });
  lines.push('## Mode philosophy');
  lines.push('');
  lines.push('Modes are reading depths, not feature flags. Easy (1) surfaces obvious anchors. Functional (2) separates info by role. Structural (3) makes local structure visible. Systems (4) perceives unstated structure (assumptions, tensions, tradeoffs). Regenerative (5) reconstructs the whole from structure.');
  lines.push('');
  lines.push('## Routing frameworks (downstream)');
  lines.push('');
  lines.push('- **NEDF**: concept identity (Def, Mn, Ex, An)');
  lines.push('- **CAST**: claim graphs, relations, time, place (R, Ev, D, P, L, T, X, Opp, Assump)');
  lines.push('- **SPEAR**: procedures, mechanisms, constraints (C, B, A)');
  lines.push('- **HEART**: people (N)');
  lines.push('- **ORACLE**: measurement / prediction (M)');
  lines.push('- **GRACE**: social-pragmatic (reserved)');
  lines.push('');
  lines.push('## How to choose a tag');
  lines.push('');
  lines.push('Ask: *what structural role does this span play in the argument?* — not *what is it about?*');
  lines.push('');
  lines.push('- If the span names a concept and points at its identity → **Def**');
  lines.push('- If it gives the *what-it-means-here* gloss of a Def → **Mn**');
  lines.push('- If it is a concrete instance → **Ex**; if it is a comparison → **An**');
  lines.push('- If it asserts X causes / supports / depends on Y → **R**');
  lines.push('- If it is data / case backing a relation → **Ev**');
  lines.push('- If it states a limit, choke point, or temporal delay → **C / B / L**');
  lines.push('- If it surfaces a tradeoff, conflict, opposing view, or unstated requirement → **T / X / Opp / Assump**');
  lines.push('- If it raises a question to revisit → **Q**');
  lines.push('- If it tells the reader what to *do* → **A**; if it tells them how to *measure success* → **M**');
  lines.push('- People → **N**; dates → **D**; places → **P**');
  lines.push('');
  lines.push('Prefer the most specific applicable tag (e.g. Mn over Def for a gloss; Opp over X for an alternative view).');
  lines.push('');
  lines.push('## What you do NOT do');
  lines.push('');
  lines.push("- You don't paraphrase the user's prose or correct it.");
  lines.push('- You only propose spans that are *literally present* in the paragraph (verbatim substrings).');
  lines.push('- You never propose overlapping spans for the same tag.');
  lines.push('- You stay inside the mode\'s allowed sigil set.');
  lines.push('- You return spans verbatim — do not normalise whitespace, case, or punctuation.');
  return lines.join('\n');
}

// Prompt for tag suggestion: given a paragraph, return 0–N proposed tags.
export function suggestUserPrompt(paragraph: string, existingTags: { tag: string; text: string }[]): string {
  const lines: string[] = [];
  lines.push('Below is a single paragraph the user is reading. Propose 0–5 semantic tags they could apply.');
  lines.push('');
  lines.push('Constraints:');
  lines.push('- Use only sigils in the active mode (listed in the system prompt).');
  lines.push("- Each proposed `span` must be a verbatim substring of the paragraph below — copy it character-for-character, including whitespace.");
  lines.push('- Do not propose overlapping spans for the same sigil.');
  lines.push('- Do not propose tags that duplicate the existing tags listed below.');
  lines.push('- Skip the paragraph entirely (return an empty array) if no tag is clearly justified.');
  lines.push('');
  if (existingTags.length) {
    lines.push('Existing tags on this paragraph:');
    existingTags.forEach(e => lines.push(`- ${e.tag}: "${e.text}"`));
    lines.push('');
  }
  lines.push('Paragraph:');
  lines.push('"""');
  lines.push(paragraph);
  lines.push('"""');
  lines.push('');
  lines.push('Respond with JSON only, matching the schema. No prose.');
  return lines.join('\n');
}

// Prompt for synthesis: hand the model a slice of the vault index plus a template instruction.
export function synthesisUserPrompt(templateName: string, instruction: string, slice: string): string {
  return [
    `Template: **${templateName}**.`,
    '',
    instruction,
    '',
    'Vault slice (the only data you may cite):',
    '"""',
    slice,
    '"""',
    '',
    'Write the requested document in Markdown. Every claim drawn from the slice must cite its source as `[[Note#^block-id]]`. Do not invent block-ids — use only the ones that appear in the slice.',
  ].join('\n');
}
