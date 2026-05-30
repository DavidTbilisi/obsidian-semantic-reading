import { Paragraph, plainTextOf } from '../syntax';
import { TAGS, FRAMEWORKS, FRAMEWORK_ORDER } from '../constants';

interface RouteItem {
  tag: string;
  name: string;
  text: string;
  paragraph: number;
  crossCutting?: boolean;
}

interface RouteBucket {
  name: string;
  desc: string;
  items: RouteItem[];
}

export function routeToFrameworks(paragraphs: Paragraph[]): Record<string, RouteBucket> {
  const buckets: Record<string, RouteItem[]> = {};
  FRAMEWORK_ORDER.forEach(f => { buckets[f] = []; });
  const crossCutting: RouteItem[] = [];

  paragraphs.forEach((segs, pi) => {
    segs.forEach(s => {
      if (!s.tag) return;
      const def = TAGS[s.tag];
      if (!def) return;
      const route = def.route;
      const item: RouteItem = { tag: s.tag, name: def.name, text: s.text.trim(), paragraph: pi + 1 };
      if (route === '*') crossCutting.push(item);
      else if (buckets[route]) buckets[route].push(item);
    });
  });

  if (crossCutting.length) {
    FRAMEWORK_ORDER.forEach(f => {
      if (buckets[f].length) {
        buckets[f] = buckets[f].concat(crossCutting.map(x => ({ ...x, crossCutting: true })));
      }
    });
  }

  const out: Record<string, RouteBucket> = {};
  FRAMEWORK_ORDER.forEach(f => {
    if (buckets[f].length) {
      out[f] = { name: FRAMEWORKS[f].name, desc: FRAMEWORKS[f].desc, items: buckets[f] };
    }
  });
  return out;
}

function csvField(s: string): string {
  const v = s == null ? '' : String(s);
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

export function buildAnkiCsvs(paragraphs: Paragraph[]): Record<string, string> {
  const paragraphTexts = paragraphs.map(plainTextOf);
  const by = routeToFrameworks(paragraphs);
  const out: Record<string, string> = {};
  Object.keys(by).forEach(framework => {
    const rows = ['Front,Back,Tags'];
    by[framework].items.forEach(it => {
      const ctx = (paragraphTexts[it.paragraph - 1] || '').trim();
      const front = it.text;
      const back = it.name + ' — ¶' + it.paragraph + ': ' + ctx;
      const tags = framework + ' ' + it.tag + ' p' + it.paragraph + (it.crossCutting ? ' cross-cutting' : '');
      rows.push([csvField(front), csvField(back), csvField(tags)].join(','));
    });
    out[framework] = rows.join('\r\n');
  });
  return out;
}

export function safeName(s: string): string {
  return (s || 'note').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'note';
}
