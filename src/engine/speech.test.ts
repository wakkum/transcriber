import { describe, expect, it } from 'vitest';
import { quietestPoint, silenceThreshold, snapToQuiet, speechEnd, speechPieces } from './speech';

const SR = 1000; // 1 kHz keeps sample math readable

describe('speechEnd', () => {
  // 0.0 to 0.5 s loud "word", then silence; Whisper claimed the word ran to 1.5 s
  const s = new Float32Array(2000);
  s.fill(0.5, 0, 500);
  it('trims a stretched word end back to where the sound stops', () => {
    const end = speechEnd(s, SR, 0, 1.5, silenceThreshold(s, SR));
    expect(end).toBeGreaterThan(0.5);
    expect(end).toBeLessThan(0.6);
  });
  it('leaves a word that is sounding at its end untouched', () => {
    expect(speechEnd(s, SR, 0, 0.4, 0.01)).toBe(0.4);
  });
});

describe('snapToQuiet', () => {
  it('moves a cut into the nearby silent gap', () => {
    const s = new Float32Array(1000).fill(0.8);
    s.fill(0, 600, 640); // silence at 0.60 to 0.64 s
    const t = snapToQuiet(s, SR, 0.55, 0.5, 0.7);
    expect(t).toBeGreaterThanOrEqual(0.6);
    expect(t).toBeLessThanOrEqual(0.64);
  });
  it('keeps the original point over flat silence', () => {
    const s = new Float32Array(1000);
    expect(snapToQuiet(s, SR, 0.5, 0.4, 0.6)).toBeCloseTo(0.5, 2);
  });
});

describe('speechPieces', () => {
  // seconds of sound/silence -> 1 kHz signal
  const signal = (parts: [number, boolean][]) => {
    const out: number[] = [];
    for (const [sec, loud] of parts) for (let i = 0; i < sec * SR; i++) out.push(loud ? 0.5 : 0);
    return Float32Array.from(out);
  };
  const round = (p: [number, number][]) => p.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]);

  it('skips long silences and keeps a pad around speech', () => {
    const s = signal([[30, false], [5, true], [10, false], [4, true], [3, false]]);
    expect(round(speechPieces(s, SR, 0.01))).toEqual([[29.7, 35.3], [44.7, 49.3]]);
  });

  it('joins sound across short gaps and splits long runs at a pause, padding both sides', () => {
    const s = signal([[10, true], [0.2, false], [10, true], [1, false], [10, true]]);
    const p = speechPieces(s, SR, 0.01, { maxLen: 25 });
    expect(round(p)).toEqual([[0, 20.5], [20.9, 31.2]]);
  });

  it('splits continuous speech longer than a piece at the quietest point', () => {
    const s = signal([[40, true]]);
    s.fill(0.1, 26_000, 26_050);
    const p = speechPieces(s, SR, 0.01, { maxLen: 28 });
    expect(p).toHaveLength(2);
    expect(p[0][1]).toBeGreaterThan(26);
    expect(p[0][1]).toBeLessThan(26.05);
    expect(p[1][0]).toBe(p[0][1]);
  });

  it('terminates and moves forward with a very short maximum length', () => {
    const loud = new Float32Array(SR * 3).fill(0.5);
    const pieces = speechPieces(loud, SR, 0.01, { maxLen: 0.5, pad: 0 });
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.every(([a, b]) => b > a)).toBe(true);
  });
});

describe('quietestPoint', () => {
  it('finds the middle of the quietest stretch', () => {
    const SR = 1000;
    const x = Float32Array.from({ length: 5000 }, (_, i) => (i >= 2000 && i < 2800 ? 0 : 0.5 * Math.sin(i / 5)));
    const at = quietestPoint(x, SR, 0.4);
    expect(at).toBeGreaterThan(2000);
    expect(at).toBeLessThan(2800);
  });
  it('copes with short input', () => {
    expect(quietestPoint(new Float32Array(10), 1000)).toBe(5);
  });
});
