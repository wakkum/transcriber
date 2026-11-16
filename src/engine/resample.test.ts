import { describe, expect, it } from 'vitest';
import { findHoles, MonoResampler } from './resample';

const sine = (n: number, rate: number, hz: number) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));

/** Zero crossings per second, a rough frequency reading. */
const crossings = (x: Float32Array, rate: number) => {
  let c = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 !== x[i] < 0) c++;
  return c / 2 / (x.length / rate);
};

describe('MonoResampler', () => {
  it('turns 48 kHz into a third as many samples, keeping a constant level', () => {
    const r = new MonoResampler(48_000, 16_000);
    r.push([new Float32Array(4800).fill(0.5)]);
    const out = r.finish();
    expect(out).toHaveLength(1600);
    expect(out.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it('handles rates that do not divide evenly (44.1 kHz) and keeps the pitch', () => {
    const r = new MonoResampler(44_100, 16_000);
    r.push([sine(44_100, 44_100, 440)]);
    const out = r.finish();
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1);
    expect(crossings(out, 16_000)).toBeCloseTo(440, -1);
  });

  it('gives the same result fed in chunks as in one go', () => {
    const x = sine(10_000, 44_100, 300);
    const whole = new MonoResampler(44_100, 16_000);
    whole.push([x]);
    const parts = new MonoResampler(44_100, 16_000);
    for (let i = 0; i < x.length; i += 777) parts.push([x.subarray(i, i + 777)]);
    const a = whole.finish();
    const b = parts.finish();
    expect(b).toHaveLength(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 5);
  });

  it('averages channels to mono and adds silence', () => {
    const r = new MonoResampler(16_000, 16_000);
    r.pushSilence(0.001);
    r.push([Float32Array.of(1, 1), Float32Array.of(0, -1)]);
    expect([...r.finish()]).toEqual([...new Array(16).fill(0), 0.5, 0]);
  });

  it('upsamples low-rate files too', () => {
    const r = new MonoResampler(8_000, 16_000);
    r.push([Float32Array.of(0.25, 0.75)]);
    expect([...r.finish()]).toEqual([0.25, 0.25, 0.75, 0.75]);
  });
});

describe('findHoles', () => {
  const packets = (...at: number[]) => at.map((timestamp) => ({ timestamp, duration: 1 }));
  it('finds a late start and jumps, with how much audio comes before each', () => {
    expect(findHoles(packets(3, 4, 5, 6))).toEqual([{ at: 0, gap: 3 }]);
    expect(findHoles(packets(0, 1, 2, 8, 9))).toEqual([{ at: 3, gap: 5 }]);
    expect(findHoles(packets(2, 3, 9, 10, 20))).toEqual([{ at: 0, gap: 2 }, { at: 2, gap: 5 }, { at: 4, gap: 9 }]);
  });
  it('ignores rounding, overlaps and a clean track', () => {
    expect(findHoles(packets(0, 1, 2, 3))).toEqual([]);
    expect(findHoles([{ timestamp: 0.01, duration: 0.5 }, { timestamp: 0.52, duration: 0.5 }])).toEqual([]);
    expect(findHoles(packets(0, 1, 1.5, 2.5))).toEqual([]);
    expect(findHoles(packets(-0.02, 0.98))).toEqual([]);
    expect(findHoles([])).toEqual([]);
  });
});

describe('MonoResampler pieces', () => {
  const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i);
  it('hands out the first samples and keeps the rest in order', () => {
    const r = new MonoResampler(16_000, 16_000);
    r.push([ramp(5)]);
    r.push([Float32Array.from({ length: 5 }, (_, i) => 5 + i)]);
    expect([...r.take(3)]).toEqual([0, 1, 2]);
    expect(r.size).toBe(7);
    expect([...r.take(6)]).toEqual([3, 4, 5, 6, 7, 8]);
    expect([...r.finish()]).toEqual([9]);
  });
  it('shows the last samples without removing them', () => {
    const r = new MonoResampler(16_000, 16_000);
    r.push([ramp(4)]);
    r.push([Float32Array.from({ length: 4 }, (_, i) => 4 + i)]);
    expect([...r.tail(5)]).toEqual([3, 4, 5, 6, 7]);
    expect(r.size).toBe(8);
    expect([...r.tail(100)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
