// The transcript as a PDF, written directly: A4 pages in the PDF's built-in Helvetica, so nothing is
// embedded and the file stays small. Built-in fonts only cover Western European text (WinAnsi), so
// `canWritePdf` says when a transcript needs the browser's print dialog instead (Arabic, Cyrillic, ...).
// Text widths come from `measure`, injected, since the engine has no DOM.
import { rowsOf, speakerLabel, translationOf, type ExportOptions, type Para } from './transcript';

/** Width of `text` in points at `size` points. */
export type Measure = (text: string, size: number, bold: boolean) => number;

// Windows-1252 bytes 0x80 to 0x9F; the rest of 0xA0 to 0xFF is Latin-1, the same as Unicode
const CP1252 = new Map<string, number>(
  [...'€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0\0‘’“”•–—˜™š›œ\0žŸ'].flatMap((c, i) => (c === '\0' ? [] : [[c, 0x80 + i] as [string, number]])),
);

const byteOf = (c: string): number | null => {
  const code = c.codePointAt(0)!;
  if ((code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff)) return code;
  return CP1252.get(c) ?? null;
};

/** True when every character can be written with the built-in fonts. */
export const canWritePdf = (text: string) => [...text.replace(/\s/g, ' ')].every((c) => byteOf(c) != null);

/** A PDF string literal for `text` in WinAnsi, with bytes outside ASCII as octal escapes. */
export function pdfString(text: string): string {
  let out = '(';
  for (const c of text.replace(/\s/g, ' ')) {
    const b = byteOf(c) ?? 0x3f; // "?" for anything the fonts lack
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${c}`;
    else if (b < 0x20 || b > 0x7e) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += c;
  }
  return `${out})`;
}

/** Greedy word wrap to `width` points; a word longer than a line is broken. */
export function wrap(text: string, width: number, size: number, measure: Measure, bold = false): string[] {
  const lines: string[] = [];
  let cur = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (measure(next, size, bold) <= width) {
      cur = next;
      continue;
    }
    if (cur) lines.push(cur);
    cur = '';
    while (measure(word, size, bold) > width && word.length > 1) {
      let n = word.length - 1;
      while (n > 1 && measure(word.slice(0, n), size, bold) > width) n--;
      lines.push(word.slice(0, n));
      word = word.slice(n);
    }
    cur = word;
  }
  if (cur) lines.push(cur);
  return lines;
}

type Op = { x: number; y: number; text: string; size: number; bold: boolean; grey: number };

const PAGE = { w: 595.28, h: 841.89 };
const M = { x: 64, top: 72, bottom: 72 };
const BODY = 11;
const LEAD = 16;

/** Lay the transcript out in pages of text positions. */
export function layoutPages(title: string, subtitle: string, paras: Para[], opts: ExportOptions, measure: Measure): Op[][] {
  const pages: Op[][] = [[]];
  let y = PAGE.h - M.top;
  const width = PAGE.w - 2 * M.x;
  const room = (h: number) => {
    if (y - h < M.bottom) {
      pages.push([]);
      y = PAGE.h - M.top;
    }
  };
  const put = (x: number, text: string, size: number, bold = false, grey = 0) => pages.at(-1)!.push({ x, y, text, size, bold, grey });

  for (const line of wrap(title, width, 20, measure, true)) {
    room(26);
    y -= 20;
    put(M.x, line, 20, true);
    y -= 6;
  }
  y -= 4;
  room(14);
  y -= 10.5;
  put(M.x, subtitle, 10.5, false, 0.4);
  y -= 22;

  const indent = opts.timecodes ? measure('[00:00:00]  ', BODY, false) : 0;
  for (const p of paras) {
    const who = speakerLabel(p, opts);
    if (who) {
      for (const line of wrap(who, width, BODY, measure, true)) {
        room(LEAD);
        y -= LEAD;
        put(M.x, line, BODY, true);
      }
    }
    for (const row of rowsOf(p, opts)) {
      const lines = wrap(row.text, width - indent, BODY, measure);
      lines.forEach((text, i) => {
        room(LEAD);
        y -= LEAD;
        if (i === 0 && row.time) put(M.x, row.time, BODY, false, 0.5);
        put(M.x + indent, text, BODY);
      });
    }
    const tr = translationOf(p, opts);
    if (tr) {
      // the translation under the paragraph, in grey
      for (const text of wrap(tr, width - indent, BODY, measure)) {
        room(LEAD);
        y -= LEAD;
        put(M.x + indent, text, BODY, false, 0.35);
      }
    }
    y -= 9; // space between paragraphs
  }
  return pages;
}

const num = (n: number) => String(Math.round(n * 100) / 100);

/** A complete PDF file. Check `canWritePdf` on the text first. */
export function pdfFile(title: string, subtitle: string, paras: Para[], opts: ExportOptions, measure: Measure): Uint8Array {
  const pages = layoutPages(title, subtitle, paras, opts, measure);
  const content = (ops: Op[], n: number) => {
    const footer = `${n} / ${pages.length}`;
    const all = [...ops, { x: (PAGE.w - measure(footer, 9, false)) / 2, y: 40, text: footer, size: 9, bold: false, grey: 0.5 }];
    return all.map((o) => `BT ${o.grey ? `${num(o.grey)} g ` : '0 g '}/${o.bold ? 'F2' : 'F1'} ${o.size} Tf ${num(o.x)} ${num(o.y)} Td ${pdfString(o.text)} Tj ET`).join('\n');
  };
  // 1 catalog, 2 page tree, 3 and 4 fonts, 5 info, then a page and its content per page
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${6 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title ${pdfString(title)} /Producer (Transcriber) >>`,
  ];
  pages.forEach((ops, i) => {
    const stream = content(ops, i + 1);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + 2 * i} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  // every string above is ASCII (escapes included), so its length is its byte count
  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}
