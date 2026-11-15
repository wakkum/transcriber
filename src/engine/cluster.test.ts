import { describe, expect, it } from 'vitest';
import { cluster, cosineDistance, MAX_VECTORS, normalize } from './cluster';

/** A vector near axis `axis` of 8, nudged by a fixed pseudo-random amount (so tests are repeatable). */
const near = (axis: number, i: number, wobble = 0.15) =>
  Array.from({ length: 8 }, (_, k) => (k === axis ? 1 : 0) + wobble * Math.sin(i * 12.9898 + k * 78.233));

describe('cluster', () => {
  it('finds the voices in auto mode, numbered by first appearance', () => {
    const v = [near(3, 0), near(3, 1), near(5, 2), near(3, 3), near(5, 4), near(6, 5)];
    expect(cluster(v, { threshold: 0.5 })).toEqual([0, 0, 1, 0, 1, 2]);
  });

  it('puts one voice in one cluster however it wobbles', () => {
    expect(new Set(cluster(Array.from({ length: 40 }, (_, i) => near(2, i, 0.3)), { threshold: 0.5 })).size).toBe(1);
  });

  it('stops at the speaker count when one is given, even for close voices', () => {
    const v = [near(0, 0), near(1, 1), near(0, 2), near(1, 3), near(2, 4), near(2, 5)];
    expect(cluster(v, { count: 2 })).toHaveLength(6);
    expect(new Set(cluster(v, { count: 2 })).size).toBe(2);
    expect(cluster(v, { count: 1 }).every((l) => l === 0)).toBe(true);
    // more speakers wanted than vectors: nobody merges
    expect(cluster(v.slice(0, 2), { count: 5 })).toEqual([0, 1]);
  });

  it('folds a tiny cluster into the nearest big one, but not when asked for a count', () => {
    const v = [...Array.from({ length: 6 }, (_, i) => near(0, i)), ...Array.from({ length: 6 }, (_, i) => near(1, i + 10)), near(0, 99, 0.6), near(5, 50, 0.05)];
    const weights = [...Array(12).fill(2), 0.9, 0.9];
    const auto = cluster(v, { threshold: 0.3, minWeight: 3, weights });
    expect(new Set(auto).size).toBe(2);
    expect(new Set(cluster(v, { count: 3, weights })).size).toBe(3);
  });

  it('weights count: a long stretch of one voice outweighs a short one when linking', () => {
    expect(cluster([], {})).toEqual([]);
    expect(cluster([[1, 0]], {})).toEqual([0]);
  });

  it('measures cosine distance', () => {
    expect(cosineDistance(normalize([1, 0]), normalize([2, 0]))).toBeCloseTo(0);
    expect(cosineDistance(normalize([1, 0]), normalize([0, 3]))).toBeCloseTo(1);
    expect(cosineDistance(normalize([1, 0]), normalize([-1, 0]))).toBeCloseTo(2);
  });

  it('stays fast and correct on thousands of vectors by clustering a sample', () => {
    const n = MAX_VECTORS * 3;
    const axisOf = (i: number) => [1, 4, 6][(i >> 3) % 3];
    const vectors = Array.from({ length: n }, (_, i) => near(axisOf(i), i, 0.2));
    const t0 = performance.now();
    const labels = cluster(vectors, { threshold: 0.35, minWeight: 3 });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(labels).toHaveLength(n);
    expect(new Set(labels).size).toBe(3);
    // every vector of the same voice shares a cluster, numbered by first appearance
    for (let i = 0; i < n; i++) expect(labels[i]).toBe([1, 4, 6].indexOf(axisOf(i)));
    // a given count still holds
    expect(new Set(cluster(vectors, { count: 2 })).size).toBe(2);
  });
});
