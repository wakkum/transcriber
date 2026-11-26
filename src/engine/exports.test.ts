import { describe, expect, it } from 'vitest';
import { documentXml, docxFile } from './docx';
import { printHtml } from './html';
import { EMBEDDING_MODEL, LANGUAGES, modelFor, QUALITIES, REVISIONS, SEGMENTATION_MODEL } from './models';
import { canWritePdf, layoutPages, pdfFile, pdfString, wrap, type Measure } from './pdf';
import { fromIdentification } from './speakers';
import { paragraphs, transcriptTxt } from './transcript';
import { words } from './fixtures';
import { crc32 } from './zip';

const paras = paragraphs([...words('Hello <there> & you.'), ...words('Second bit.', 10)]);
/** Every character 0.5 em wide. */
const measure: Measure = (t, size) => t.length * size * 0.5;

describe('docx', () => {
  it('escapes text and timecodes each line in grey', () => {
    const x = documentXml('Talk', 'Sub', paras, { timecodes: true });
    expect(x).toContain('Hello &lt;there&gt; &amp; you.');
    expect(x).toContain('<w:color w:val="808080"/></w:rPr><w:t xml:space="preserve">[00:00:10] </w:t>');
    expect(x).not.toContain('<w:bidi/>');
    expect(documentXml('Talk', 'Sub', paras, { timecodes: false })).not.toContain('[00:00');
  });

  it('makes right-to-left paragraphs for Arabic', () => {
    const x = documentXml('حوار', 'Sub', paras, { timecodes: true, rtl: true });
    expect(x).toContain('<w:pPr><w:pStyle w:val="Title"/><w:bidi/></w:pPr>');
    expect(x).toContain('<w:rtl/>');
  });

  it('packs a zip whose entries check out', () => {
    const file = docxFile('Talk', 'Sub', paras, { timecodes: true });
    const view = new DataView(file.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // first entry: [Content_Types].xml, its CRC in the header matches its data
    const nameLen = view.getUint16(26, true);
    const size = view.getUint32(18, true);
    const data = file.subarray(30 + nameLen, 30 + nameLen + size);
    expect(view.getUint32(14, true)).toBe(crc32(data));
    expect(new TextDecoder().decode(file.subarray(30, 30 + nameLen))).toBe('[Content_Types].xml');
  });
});

describe('pdf', () => {
  it('knows which text the built-in fonts can write', () => {
    expect(canWritePdf('Café “quotes” – naïve €5\tok')).toBe(true);
    expect(canWritePdf('مرحبا')).toBe(false);
    expect(canWritePdf('Привет')).toBe(false);
  });

  it('escapes strings in WinAnsi', () => {
    expect(pdfString('a (b) \\ é “x”')).toBe('(a \\(b\\) \\\\ \\351 \\223x\\224)');
  });

  it('wraps at spaces and breaks words longer than a line', () => {
    expect(wrap('one two three four', 40, 10, measure)).toEqual(['one two', 'three', 'four']);
    expect(wrap('abcdefghij', 20, 10, measure)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('flows onto new pages', () => {
    const many = paragraphs(Array.from({ length: 80 }, (_, i) => words('A line that ends.', i * 5)).flat());
    const pages = layoutPages('T', 'S', many, { timecodes: true }, measure);
    expect(pages.length).toBeGreaterThan(1);
    for (const ops of pages) for (const o of ops) expect(o.y).toBeGreaterThanOrEqual(72);
  });

  it('writes a file whose cross-reference table points at each object', () => {
    const file = pdfFile('Talk (draft)', 'Sub', paras, { timecodes: true }, measure);
    const text = String.fromCharCode(...file);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('(Talk \\(draft\\))');
    const xrefAt = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref');
    const offsets = [...text.slice(xrefAt).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(7); // 5 shared objects, one page and its content
    offsets.forEach((o, i) => expect(text.slice(o, o + 10)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    // stream lengths are exact
    const stream = text.match(/<< \/Length (\d+) >>\nstream\n/)!;
    const start = stream.index! + stream[0].length;
    expect(text.slice(start + Number(stream[1]), start + Number(stream[1]) + 10)).toBe('\nendstream');
  });
});

describe('print page', () => {
  it('escapes text and sets the direction', () => {
    const h = printHtml('A <b>', 'Sub', paras, { timecodes: true, rtl: true });
    expect(h).toContain('dir="rtl"');
    expect(h).toContain('<title>A &lt;b&gt;</title>');
    expect(h).toContain('<span class="t">[00:00:10]</span>');
  });
});

describe('models', () => {
  it('uses English-only models for English and multilingual ones otherwise', () => {
    expect(modelFor('english', 'balanced')).toEqual({ id: 'Xenova/whisper-base.en', size: '~80 MB' });
    expect(modelFor('arabic', 'accurate')).toEqual({ id: 'Xenova/whisper-small', size: '~250 MB', language: 'arabic' });
    expect(modelFor('bengali', 'fast')).toMatchObject({ id: 'shamim1122/whisper-small-bangla-onnx', language: 'bengali', pieceSeconds: 10 });
    expect(modelFor('bengali', 'balanced')).toMatchObject({ id: 'subtitleking/omikhan-bangla-whisper-medium-onnx', language: 'bengali', pieceSeconds: 10 });
    expect(modelFor('bengali', 'accurate')).toMatchObject({ id: 'subtitleking/omikhan-bangla-whisper-medium-onnx', language: 'bengali', pieceSeconds: 10 });
    // Bengali takes about 20 tokens a second: a 28 s piece would not fit Whisper's 448
    expect(modelFor('french', 'accurate').pieceSeconds).toBeUndefined();
  });
});

describe('speakers in exports', () => {
  const who = fromIdentification([...words('Hello there.'), ...words('Hi back.', 1.5), ...words('Bye now.', 3)], [0, 0, 1, 1, 0, 0]);
  const spoken = paragraphs(who.words);
  const names = { s1: 'Omar <O>', s2: 'Ann' };

  it('start a new paragraph when the speaker changes', () => {
    expect(spoken.map((p) => [p.speaker, p.words.length])).toEqual([['s1', 2], ['s2', 2], ['s1', 2]]);
  });

  it('are named in text, Word, PDF and print output, and left out when no names are given', () => {
    expect(transcriptTxt('T', 'S', spoken, { timecodes: false, speakerNames: names })).toBe('T\nS\n\nOmar <O>\nHello there.\n\nAnn\nHi back.\n\nOmar <O>\nBye now.\n');
    expect(transcriptTxt('T', 'S', spoken, { timecodes: false })).not.toContain('Ann');
    const x = documentXml('T', 'S', spoken, { timecodes: false, speakerNames: names });
    expect(x).toContain('<w:b/></w:rPr><w:t xml:space="preserve">Omar &lt;O&gt;</w:t></w:r><w:r><w:br/></w:r>');
    expect(documentXml('T', 'S', spoken, { timecodes: false })).not.toContain('<w:b/>');
    const pdf = String.fromCharCode(...pdfFile('T', 'S', spoken, { timecodes: false, speakerNames: names }, measure));
    expect(pdf).toContain('/F2 11 Tf');
    expect(pdf).toContain('(Ann)');
    expect(printHtml('T', 'S', spoken, { timecodes: false, speakerNames: names })).toContain('<strong class="who">Omar &lt;O&gt;</strong>');
  });

  it('pins every model it can ask for to an exact commit, and falls back to English for an unknown language', () => {
    const ids = [SEGMENTATION_MODEL, EMBEDDING_MODEL, ...LANGUAGES.flatMap((l) => QUALITIES.map((q) => modelFor(l.id, q.id).id))];
    for (const id of ids) expect(REVISIONS[id], id).toMatch(/^[0-9a-f]{40}$/);
    expect(modelFor('klingon', 'fast')).toEqual(modelFor('english', 'fast'));
  });
});

describe('translations under paragraphs', () => {
  const translations = { [paras[0].words[0].id]: 'আমি ভালো <আছি>.' };
  const opts = { timecodes: false, translations };
  it('adds the translation after its paragraph in every format', () => {
    expect(transcriptTxt('T', 'S', paras, opts)).toContain('Hello <there> & you.\nআমি ভালো <আছি>.\n');
    expect(documentXml('T', 'S', paras, opts)).toContain('আমি ভালো &lt;আছি&gt;.');
    expect(printHtml('T', 'S', paras, opts)).toContain('<p class="tr" dir="ltr">আমি ভালো &lt;আছি&gt;.</p>');
    expect(layoutPages('T', 'S', paras, opts, measure).flat().some((o) => o.text.includes('ভালো'))).toBe(true);
    expect(transcriptTxt('T', 'S', paras, { timecodes: false })).not.toContain('ভালো');
  });
});
