import { describe, expect, it } from 'vitest';
import { doubtful, inventedStretch, sparseRecording } from './doubt';

const w = (text: string, start: number, dur = 0.4) => ({ text, start, end: start + dur });
const ok = (n: number) => Array(n).fill(1);

describe('doubtful words', () => {
  it('leaves normal speech alone', () => {
    const words = [w('Welcome', 0), w('back', 0.5), w('to', 1), w('the', 1.4), w('program.', 1.8)];
    expect(doubtful(words, ok(5))).toEqual([false, false, false, false, false]);
  });
  it('flags a word spoken over silence', () => {
    expect(doubtful([w('Thanks', 0), w('everyone', 1)], [0.9, 0.05])).toEqual([false, true]);
  });
  it('flags a word too fast to say', () => {
    expect(doubtful([w('extraordinarily', 0, 0.1), w('would', 1, 0.1)], ok(2))).toEqual([true, false]);
  });
  it('flags loops after the second time', () => {
    const words = ['I', 'know', 'you', 'you', 'you', 'you', 'you', 'go'].map((t, i) => w(t, i));
    expect(doubtful(words, ok(8))).toEqual([false, false, false, false, true, true, true, false]);
    const phrase = ['okay', 'so', 'the', 'thing', 'the', 'thing', 'the', 'thing', 'the', 'thing', 'is'].map((t, i) => w(t, i));
    const f = doubtful(phrase, ok(11));
    expect(f.slice(0, 6)).toEqual([false, false, false, false, false, false]);
    expect(f.slice(6, 10)).toEqual([true, true, true, true]);
    expect(f[10]).toBe(false);
  });
  it('does not call a few repeats a loop', () => {
    const words = ['no', 'no', 'no'].map((t, i) => w(t, i));
    expect(doubtful(words, ok(3))).toEqual([false, false, false]);
  });
});

describe('invented stretches', () => {
  const ws = (...t: string[]) => t.map((x, i) => w(x, i));
  it('drops a stock phrase over quiet or sparse sound', () => {
    expect(inventedStretch(ws('Thanks', 'for', 'watching!'), [0.5, 0.2, 0.1], 25)).toBe(true);
    expect(inventedStretch(ws('Thanks', 'for', 'watching!'), [0.9, 0.9, 0.9], 25)).toBe(true); // 3 words in 25 s is sparse
    expect(inventedStretch(ws('Thanks', 'for', 'watching!'), [0.9, 0.9, 0.9], 2)).toBe(false);
  });
  it('drops a stretch where every word is over near silence', () => {
    expect(inventedStretch(ws('Something', 'odd'), [0.05, 0.1], 5)).toBe(true);
  });
  it('keeps real speech, including a spoken "thank you"', () => {
    expect(inventedStretch(ws('Welcome', 'back', 'to', 'the', 'program'), [0.9, 0.8, 0.9, 0.9, 0.9], 3)).toBe(false);
    expect(inventedStretch(ws('Thank', 'you.'), [0.9, 0.9], 2)).toBe(false);
    expect(inventedStretch([], [], 5)).toBe(false);
  });
});

describe('sparse recordings', () => {
  it('calls a few words in a long file invented, but not a short clip or a real talk', () => {
    expect(sparseRecording(2, 40)).toBe(true);
    expect(sparseRecording(1, 5)).toBe(false);
    expect(sparseRecording(1, 3)).toBe(false);
    expect(sparseRecording(112, 39)).toBe(false);
    expect(sparseRecording(8, 600)).toBe(false);
    expect(sparseRecording(0, 40)).toBe(false);
  });
});

describe('looping', () => {
  it('spots Whisper stuck on a letter group, a word or a phrase', async () => {
    const { looping } = await import('./doubt');
    expect(looping('সাাাাাাাাাাাাাাাাাাাাাাাাা')).toBe(true);
    expect(looping('এমামামামামামামামামামামাম')).toBe(true);
    expect(looping('কিন্তু রাশে আসচে আসচে আসচে আসচে আসচে আসচে')).toBe(true);
    expect(looping('পান্তে পান্তে পান্তে পান্তে পান্তে')).toBe(true);
    expect(looping('I said you know I said you know I said you know I said you know I said you know')).toBe(true);
  });
  it('leaves real speech alone, repeats included', () => {
    return import('./doubt').then(({ looping }) => {
      expect(looping('আর কি সু বিশে হাচ্ছে আমি এদেশে আস্ছে, রাস্যাতে আস্ছে এখন বর্তমানে উক্লেনে আস্ছে')).toBe(false);
      expect(looping('no no no, I mean yes yes')).toBe(false);
      expect(looping('Mississippi bookkeeper 2000000 hahaha')).toBe(false);
      expect(looping('')).toBe(false);
    });
  });
});

describe('doubt with sentence-level times', () => {
  it('flags only loops, not silence or speed, when word times are a guess', () => {
    const words = [w('আমি', 0, 0.01), w('দেশে', 1), w('আসছি', 2), w('আসছি', 3), w('আসছি', 4), w('আসছি', 5)];
    expect(doubtful(words, [0, 0, 1, 1, 1, 1], { timing: false })).toEqual([false, false, false, false, true, true]);
  });
});
