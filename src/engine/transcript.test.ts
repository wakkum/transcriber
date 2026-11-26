import { describe, expect, it } from 'vitest';
import { words } from './fixtures';
import { baseName, clock, isRtl, markedText, paragraphs, rowsOf, splitLines, timecode, transcriptTxt } from './transcript';

describe('paragraphs', () => {
  it('breaks after a long pause', () => {
    const ps = paragraphs([...words('Hello there.'), ...words('New topic now.', 10)]);
    expect(ps.map((p) => [p.start, p.words.length])).toEqual([[0, 2], [10, 3]]);
  });

  it('breaks a long run at a sentence end, and unpunctuated speech at the hard limit', () => {
    const long = words(`${'word '.repeat(5)}end. more words`);
    expect(paragraphs(long, { softMax: 3 }).map((p) => p.words.length)).toEqual([6, 2]);
    expect(paragraphs(words('a b c d e'), { hardMax: 2 }).map((p) => p.words.length)).toEqual([2, 2, 1]);
  });
});

describe('lines', () => {
  it('end at sentences once long enough, and at pauses', () => {
    const ws = [...words('This is the first sentence here. And a second one.'), ...words('After pause.', 12)];
    expect(splitLines(ws).map((l) => l.text)).toEqual(['This is the first sentence here.', 'And a second one.', 'After pause.']);
  });

  it('become timecoded rows, or one untimed row per paragraph', () => {
    const p = paragraphs(words('Hi. Short one.', 3725))[0];
    expect(rowsOf(p, { timecodes: true })).toEqual([{ time: '[01:02:05]', text: 'Hi. Short one.' }]);
    expect(rowsOf(p, { timecodes: false })).toEqual([{ text: 'Hi. Short one.' }]);
  });
});

describe('text export', () => {
  it('writes title, subtitle and timecoded lines', () => {
    const ps = paragraphs([...words('Hello there.'), ...words('Bye now.', 10)]);
    expect(transcriptTxt('Talk', 'Transcript', ps, { timecodes: true })).toBe('Talk\nTranscript\n\n[00:00:00] Hello there.\n\n[00:00:10] Bye now.\n');
    expect(transcriptTxt('Talk', 'Transcript', ps, { timecodes: false })).toBe('Talk\nTranscript\n\nHello there.\n\nBye now.\n');
  });
});

describe('helpers', () => {
  it('format times', () => {
    expect(timecode(3725.9)).toBe('01:02:05');
    expect(clock(65)).toBe('1:05');
    expect(clock(3725)).toBe('1:02:05');
  });
  it('tell right-to-left text', () => {
    expect(isRtl('مرحبا بكم في البرنامج')).toBe(true);
    expect(isRtl('Hello مرحبا world again')).toBe(false);
  });
  it('strip extensions', () => {
    expect(baseName('Interview 3.final.mp4')).toBe('Interview 3.final');
    expect(baseName('.wav')).toBe('.wav');
  });
});

describe('overlap marks in exports', () => {
  it('wraps each run of overlapping words and leaves the rest alone', () => {
    const w = (id: string, text: string, start: number, overlap?: boolean) => ({ id, text, start, end: start + 0.4, ...(overlap ? { overlap } : {}) });
    const words = [w('a', 'So', 0), w('b', 'yes', 0.5, true), w('c', 'I', 1, true), w('d', 'know', 1.5), w('e', 'and', 2, true)];
    expect(markedText(words)).toBe('So [overlap: yes I] know [overlap: and]');
    const para = { start: 0, words };
    expect(rowsOf(para, { timecodes: false, markOverlap: true })[0].text).toBe('So [overlap: yes I] know [overlap: and]');
    expect(rowsOf(para, { timecodes: false })[0].text).toBe('So yes I know and');
  });

  it('ends sentences at a Bengali danda', () => {
    const ws = 'আমি দেশে আসছি। রাশিয়াতে আসছি এখন বর্তমানে ইউক্রেনে আসছি।'.split(' ').map((text, i) => ({ id: `b${i}`, text, start: i * 0.4, end: i * 0.4 + 0.3 }));
    expect(splitLines(ws).map((l) => l.text)).toEqual(['আমি দেশে আসছি। রাশিয়াতে আসছি এখন বর্তমানে ইউক্রেনে আসছি।']);
    expect(paragraphs(ws, { softMax: 3, pause: 9 }).map((p) => p.words.length)).toEqual([3, 6]);
  });
});
