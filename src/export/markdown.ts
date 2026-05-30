import { Paragraph, countTags } from '../syntax';
import { TAGS, MODES } from '../constants';

export function buildMarkdown(
  title: string,
  mode: number,
  paragraphs: Paragraph[]
): string {
  const lines: string[] = [];
  const counts = countTags(paragraphs);
  const used = Object.keys(counts);
  const m = MODES[mode] || MODES[3];
  lines.push('# ' + (title || 'Untitled'));
  lines.push('');
  lines.push('**Mode**: ' + mode + ' · ' + m.name + ' — ' + m.desc);
  if (used.length) {
    lines.push('');
    lines.push('**Tag counts**: ' + used.map(t => t + '=' + counts[t]).join(', '));
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  paragraphs.forEach((segs, pi) => {
    const parts = segs.map(s => s.tag ? '[' + s.tag + ': ' + s.text + ']' : s.text);
    lines.push('**¶' + (pi + 1) + '.** ' + parts.join(''));
    lines.push('');
    const extracts = segs.filter(s => s.tag);
    if (extracts.length) {
      extracts.forEach(s => {
        const name = TAGS[s.tag!] ? TAGS[s.tag!].name : s.tag;
        lines.push('- **' + s.tag + '** (' + name + ') — ' + s.text.trim());
      });
      lines.push('');
    }
  });
  return lines.join('\n');
}
