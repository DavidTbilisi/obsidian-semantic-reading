// Dataview starter pack — a single markdown note shipped with example queries
// that read the plugin's `semantic_tags` frontmatter and call the public API.
//
// Written via the "Create Dataview starter pack" command.

import { App, normalizePath, TFile } from 'obsidian';

const STARTER_PATH = 'Semantic Reading — Dataview Helpers.md';

export const DATAVIEW_STARTER_CONTENT = `---
sr_starter: dataview
---
# Semantic Reading — Dataview Helpers

These queries read the \`semantic_tags\` frontmatter that the Semantic Reading
plugin writes into every tagged note. They require the [Dataview](https://github.com/blacksmithgu/obsidian-dataview) plugin.

The DataviewJS examples additionally call the public plugin API at
\`app.plugins.plugins["semantic-reading"].api\`.

---

## 1. Every open question across the vault

\`\`\`dataview
TABLE WITHOUT ID
  s.text AS "Question",
  file.link AS "Note",
  s.para AS "¶"
FROM ""
FLATTEN semantic_tags AS s
WHERE s.tag = "Q"
SORT file.mtime DESC
\`\`\`

## 2. Notes with the most tagged spans (top 20)

\`\`\`dataview
TABLE WITHOUT ID
  file.link AS "Note",
  length(semantic_tags) AS "Tags",
  semantic_mode AS "Mode"
FROM ""
WHERE semantic_tags
SORT length(semantic_tags) DESC
LIMIT 20
\`\`\`

## 3. Family distribution across the vault (DataviewJS)

\`\`\`dataviewjs
const sr = app.plugins.plugins["semantic-reading"]?.api;
if (!sr) { dv.paragraph("Semantic Reading plugin not loaded."); }
else {
  const families = { Anchor: 0, Meaning: 0, Structure: 0, Execution: 0 };
  const fam = {
    N: "Anchor", D: "Anchor", P: "Anchor",
    Def: "Meaning", Mn: "Meaning", Ex: "Meaning", An: "Meaning", Q: "Meaning",
    R: "Structure", Ev: "Structure", C: "Structure", B: "Structure",
    L: "Structure", T: "Structure", X: "Structure", Opp: "Structure", Assump: "Structure",
    A: "Execution", M: "Execution",
  };
  const counts = sr.queries.tagCounts();
  for (const [tag, count] of Object.entries(counts)) {
    const f = fam[tag] || "Other";
    families[f] = (families[f] || 0) + count;
  }
  dv.table(["Family", "Count"], Object.entries(families));
}
\`\`\`

## 4. Cards due now (DataviewJS)

\`\`\`dataviewjs
const sr = app.plugins.plugins["semantic-reading"]?.api;
if (!sr) { dv.paragraph("Semantic Reading plugin not loaded."); }
else {
  const due = sr.cards.due();
  if (!due.length) { dv.paragraph("No cards due. 🎉"); }
  else {
    dv.table(
      ["Tag", "Front", "Source"],
      due.slice(0, 50).map(c => [
        c.tag,
        c.front,
        \`[[\${c.source.notePath.replace(/\\.md$/, "")}#^\${c.source.blockId}|open]]\`,
      ]),
    );
  }
}
\`\`\`

## 5. Top concepts by mention count (DataviewJS)

\`\`\`dataviewjs
const sr = app.plugins.plugins["semantic-reading"]?.api;
if (!sr) { dv.paragraph("Semantic Reading plugin not loaded."); }
else {
  const concepts = sr.queries.concepts()
    .sort((a, b) => b.mentions.length - a.mentions.length)
    .slice(0, 30);
  dv.table(
    ["Concept", "Mentions", "Co-occurring"],
    concepts.map(c => [
      \`[[\${app.plugins.plugins["semantic-reading"].settings.conceptsFolder}/\${c.canonical}|\${c.display}]]\`,
      c.mentions.length,
      Object.keys(c.coOccurs).length,
    ]),
  );
}
\`\`\`

---

### How to use

- Apply tags inline with the tagbar — \`{{Def|cognition}}\`, \`{{Q|why does it work?}}\`, etc.
- The plugin syncs \`semantic_tags\` frontmatter on save; queries above read from it.
- Custom tags are picked up automatically when you add them in settings.

### Public API reference

\`\`\`js
const sr = app.plugins.plugins["semantic-reading"]?.api;
sr.queries.byTag("R")              // all relations in the vault
sr.queries.concept("cognition")    // single concept hub entry
sr.queries.openQuestions()         // Q mentions
sr.queries.tagCounts()             // {Def: 14, Q: 8, ...}
sr.cards.due()                     // FSRS-due cards
sr.parse.canonicalize("Some Term") // "some-term"
sr.onIndexChange(() => /* … */)    // subscribe to changes
\`\`\`
`;

export async function writeDataviewStarter(app: App): Promise<{ path: string; created: boolean }> {
  const path = normalizePath(STARTER_PATH);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, DATAVIEW_STARTER_CONTENT);
    return { path, created: false };
  }
  await app.vault.create(path, DATAVIEW_STARTER_CONTENT);
  return { path, created: true };
}
