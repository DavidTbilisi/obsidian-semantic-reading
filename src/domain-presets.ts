// Starter domain profiles shipped with the plugin. Loaded into settings on
// first run and editable from there — users can rename, tweak, disable, or
// delete. Adding new presets here only affects fresh installs; existing
// users' settings.domains are preserved as-is.

import { DomainProfile } from './domains';

export const DOMAIN_PRESETS: DomainProfile[] = [
  {
    name: 'programming',
    label: 'Programming',
    mergeMode: 'add',
    tags: [
      { sigil: 'Fn',   name: 'Function',       family: 'Execution', desc: 'a function / procedure',                  light: '#3b6ea5', dark: '#7ab8ff' },
      { sigil: 'Cls',  name: 'Class',          family: 'Anchor',    desc: 'class / type / module',                   light: '#5e5ba3', dark: '#a89dff' },
      { sigil: 'Algo', name: 'Algorithm',      family: 'Structure', desc: 'algorithm or method',                     light: '#226d6d', dark: '#7adcdc' },
      { sigil: 'Bug',  name: 'Bug',            family: 'Structure', desc: 'known defect or footgun',                 light: '#a23b3b', dark: '#ff8a7a' },
      { sigil: 'Perf', name: 'Performance',    family: 'Structure', desc: 'performance characteristic',              light: '#8c5a1a', dark: '#ffb96b' },
      { sigil: 'API',  name: 'API',            family: 'Anchor',    desc: 'public interface / endpoint',             light: '#3b6ea5', dark: '#9cd0ff' },
      { sigil: 'Pat',  name: 'Pattern',        family: 'Meaning',   desc: 'design pattern / idiom',                  light: '#5e5ba3', dark: '#b9aaff' },
      { sigil: 'DS',   name: 'Data structure', family: 'Anchor',    desc: 'a data structure',                        light: '#226d6d', dark: '#9be4e4' },
    ],
  },
  {
    name: 'bible',
    label: 'Bible',
    mergeMode: 'subset',
    keepBuiltins: ['Def', 'Q', 'R', 'N', 'P'],
    tags: [
      { sigil: 'Vrs',  name: 'Verse',     family: 'Anchor',    desc: 'scripture reference (book ch:vs)',        light: '#5b3a7a', dark: '#c7a4ff' },
      { sigil: 'Cmd',  name: 'Command',   family: 'Execution', desc: 'imperative — what to do',                 light: '#8c5a1a', dark: '#ffc070' },
      { sigil: 'Prom', name: 'Promise',   family: 'Meaning',   desc: 'a promise / blessing',                    light: '#226d6d', dark: '#8ce0c8' },
      { sigil: 'Cov',  name: 'Covenant',  family: 'Structure', desc: 'covenant / treaty / oath',                light: '#3b6ea5', dark: '#9cc7ff' },
      { sigil: 'Prph', name: 'Prophecy',  family: 'Structure', desc: 'prophetic statement',                     light: '#5b3a7a', dark: '#dba8ff' },
      { sigil: 'Typ',  name: 'Typology',  family: 'Meaning',   desc: 'type/antitype foreshadowing',             light: '#8c4a6e', dark: '#ffa3c9' },
      { sigil: 'Char', name: 'Character', family: 'Anchor',    desc: 'biblical figure',                         light: '#6b6b3a', dark: '#e6e08a' },
    ],
  },
  {
    name: 'science',
    label: 'Science',
    mergeMode: 'add',
    tags: [
      { sigil: 'Hyp', name: 'Hypothesis', family: 'Meaning',   desc: 'a testable claim',                light: '#3b6ea5', dark: '#9cc7ff' },
      { sigil: 'Var', name: 'Variable',   family: 'Anchor',    desc: 'a measured quantity',             light: '#226d6d', dark: '#8ce0c8' },
      { sigil: 'Exp', name: 'Experiment', family: 'Execution', desc: 'experimental procedure',          light: '#8c5a1a', dark: '#ffc070' },
      { sigil: 'Res', name: 'Result',     family: 'Structure', desc: 'empirical finding',               light: '#5e5ba3', dark: '#b9aaff' },
      { sigil: 'Lit', name: 'Literature', family: 'Anchor',    desc: 'citation / prior work',           light: '#5b3a7a', dark: '#c7a4ff' },
      { sigil: 'Stt', name: 'Statistic',  family: 'Structure', desc: 'a statistic / effect size',       light: '#a23b3b', dark: '#ff8a7a' },
    ],
  },
  {
    name: 'legal',
    label: 'Legal',
    mergeMode: 'subset',
    keepBuiltins: ['Def', 'R', 'Q', 'A'],
    tags: [
      { sigil: 'Stt',  name: 'Statute',     family: 'Anchor',    desc: 'codified statute',                light: '#3b6ea5', dark: '#9cc7ff' },
      { sigil: 'Hold', name: 'Holding',     family: 'Structure', desc: 'court holding / ruling',          light: '#a23b3b', dark: '#ff8a7a' },
      { sigil: 'Dict', name: 'Dicta',       family: 'Structure', desc: 'non-binding judicial dicta',     light: '#6b6b3a', dark: '#e6e08a' },
      { sigil: 'Prec', name: 'Precedent',   family: 'Structure', desc: 'cited precedent case',           light: '#5b3a7a', dark: '#c7a4ff' },
      { sigil: 'Cls',  name: 'Clause',      family: 'Anchor',    desc: 'contract clause / provision',    light: '#5e5ba3', dark: '#b9aaff' },
      { sigil: 'Rule', name: 'Rule',        family: 'Meaning',   desc: 'extracted rule of law',          light: '#226d6d', dark: '#8ce0c8' },
    ],
  },
  {
    name: 'meeting',
    label: 'Meeting / business',
    mergeMode: 'add',
    tags: [
      { sigil: 'Dec',  name: 'Decision',  family: 'Execution', desc: 'a decision made',          light: '#226d6d', dark: '#8ce0c8' },
      { sigil: 'Own',  name: 'Owner',     family: 'Anchor',    desc: 'who owns the action',     light: '#3b6ea5', dark: '#9cc7ff' },
      { sigil: 'Rsk',  name: 'Risk',      family: 'Structure', desc: 'identified risk',         light: '#a23b3b', dark: '#ff8a7a' },
      { sigil: 'Blk',  name: 'Blocker',   family: 'Structure', desc: 'a blocker / dependency',  light: '#8c5a1a', dark: '#ffc070' },
      { sigil: 'MS',   name: 'Milestone', family: 'Anchor',    desc: 'milestone / deliverable', light: '#5b3a7a', dark: '#c7a4ff' },
    ],
  },
];
