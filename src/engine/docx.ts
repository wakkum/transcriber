// The transcript as a Word document (.docx): title, subtitle, then each paragraph with every line on
// its own row behind a grey timecode, in a minimal package of five XML parts zipped by zip.ts.
// Right-to-left transcripts (Arabic, Hebrew) get right-to-left paragraphs.
import { isRtl, rowsOf, speakerLabel, translationOf, type ExportOptions, type Para } from './transcript';
import { zipStored } from './zip';

/** Text for XML: escaped, and without the control characters XML can't hold. */
// eslint-disable-next-line no-control-regex
const xml = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const STYLES = `${HEAD}<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:rPr><w:color w:val="666666"/></w:rPr></w:style>
</w:styles>`;

const FILES = {
  '[Content_Types].xml': `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  '_rels/.rels': `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels': `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  'word/styles.xml': STYLES,
};

/** The document.xml body: title, subtitle, then the paragraphs. */
export function documentXml(title: string, subtitle: string, paras: Para[], opts: ExportOptions & { rtl?: boolean }): string {
  const rtl = !!opts.rtl;
  const rPr = (extra = '') => (extra || rtl ? `<w:rPr>${extra}${rtl ? '<w:rtl/>' : ''}</w:rPr>` : '');
  const run = (text: string, bold = false) => `<w:r>${rPr(bold ? '<w:b/>' : '')}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
  // grey, so the text reads first
  const timeRun = (text: string) => `<w:r>${rPr('<w:color w:val="808080"/>')}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
  const para = (inner: string, style?: string) => {
    const pPr = (style ? `<w:pStyle w:val="${style}"/>` : '') + (rtl ? '<w:bidi/>' : '');
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
  };
  const br = '<w:r><w:br/></w:r>';
  const body = [
    para(run(title), 'Title'),
    para(run(subtitle), 'Subtitle'),
    ...paras.map((p) => {
      const who = speakerLabel(p, opts);
      // the speaker in bold on its own row, then each line
      const tr = translationOf(p, opts);
      const main = para((who ? run(who, true) + br : '') + rowsOf(p, opts).map((r) => (r.time ? timeRun(`${r.time} `) : '') + run(r.text)).join(br));
      // the translation follows in grey italics, laid out in its own language's direction
      const back = isRtl(tr ?? '');
      const trPara = tr ? `<w:p><w:pPr>${back ? '<w:bidi/>' : ''}</w:pPr><w:r><w:rPr><w:i/><w:color w:val="595959"/>${back ? '<w:rtl/>' : ''}</w:rPr><w:t xml:space="preserve">${xml(tr)}</w:t></w:r></w:p>` : '';
      return main + trPara;
    }),
  ].join('');
  return `${HEAD}<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

/** A complete .docx file. */
export function docxFile(title: string, subtitle: string, paras: Para[], opts: ExportOptions & { rtl?: boolean }): Uint8Array {
  const enc = new TextEncoder();
  const files = { ...FILES, 'word/document.xml': documentXml(title, subtitle, paras, opts) };
  return zipStored(Object.entries(files).map(([name, text]) => ({ name, data: enc.encode(text) })));
}
