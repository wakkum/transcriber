// The transcript as a printable HTML page, for a PDF through the browser's print dialog ("Save as
// PDF") when the text needs fonts the direct PDF writer lacks. The browser shapes every script and
// lays out right-to-left text itself.
import { isRtl, rowsOf, speakerLabel, translationOf, type ExportOptions, type Para } from './transcript';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function printHtml(title: string, subtitle: string, paras: Para[], opts: ExportOptions & { rtl?: boolean }): string {
  const body = paras
    .map((p) => `<p>${speakerLabel(p, opts) ? `<strong class="who">${esc(speakerLabel(p, opts)!)}</strong>` : ''}${rowsOf(p, opts).map((r) => `<span class="row">${r.time ? `<span class="t">${esc(r.time)}</span>` : ''}<span>${esc(r.text)}</span></span>`).join('')}</p>${translationOf(p, opts) ? `<p class="tr" dir="${isRtl(translationOf(p, opts)!) ? 'rtl' : 'ltr'}">${esc(translationOf(p, opts)!)}</p>` : ''}`)
    .join('\n');
  return `<!doctype html>
<html lang="und" dir="${opts.rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
@page { size: A4; margin: 22mm 22mm 24mm; }
body { font: 11pt/1.5 -apple-system, "Segoe UI", "Noto Sans", "Noto Naskh Arabic", Arial, sans-serif; color: #111; margin: 0; }
h1 { font-size: 20pt; margin: 0 0 4pt; }
.sub { color: #666; font-size: 10.5pt; margin: 0 0 18pt; }
p { margin: 0 0 9pt; }
.tr { color: #444; font-style: italic; margin-top: -4pt; }
.who { display: block; margin-bottom: 1pt; }
.row { display: ${opts.timecodes ? 'flex' : 'inline'}; gap: 10pt; break-inside: avoid; }
.t { color: #808080; font-variant-numeric: tabular-nums; white-space: nowrap; direction: ltr; unicode-bidi: isolate; }
</style></head><body>
<h1>${esc(title)}</h1>
<p class="sub">${esc(subtitle)}</p>
${body}
</body></html>`;
}
