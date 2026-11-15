// Grouping voice embeddings into speakers: agglomerative clustering (average linkage on cosine
// distance), stopping at a distance threshold or at a speaker count the user gave. Small clusters
// (a cough, one "mm-hm" that looked like a voice) are folded into the nearest big one.

export type ClusterOptions = {
  /** Auto mode: stop merging when the closest two clusters are further apart than this (cosine distance, 0 to 2). */
  threshold?: number;
  /** Stop at exactly this many clusters instead (or fewer, if there are not that many vectors). */
  count?: number;
  /** Auto mode: clusters with less total weight than this join the nearest bigger one. */
  minWeight?: number;
  /** How much each vector counts (seconds of speech behind it). Default 1 each. */
  weights?: number[];
};

/** Above this many vectors clustering works on an even sample (the distance matrix grows with the square). */
export const MAX_VECTORS = 1500;

export function normalize(v: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  return Float32Array.from(v as ArrayLike<number>, (x) => x / norm);
}

/** 1 minus the cosine of the angle between two unit vectors. */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot;
}

/**
 * A cluster number for each vector, numbered in order of first appearance (so the voice that
 * speaks first is 0). Vectors need not be normalized.
 */
export function cluster(vectors: ArrayLike<number>[], options: ClusterOptions = {}): number[] {
  return vectors.length > MAX_VECTORS ? clusterSampled(vectors, options) : clusterAll(vectors, options);
}

/**
 * Hours of speech give thousands of vectors, and the distance matrix would need hundreds of MB:
 * cluster an even sample (each member carrying the weight of the vectors it stands for), then put
 * every vector with the nearest cluster centre.
 */
function clusterSampled(vectors: ArrayLike<number>[], options: ClusterOptions): number[] {
  const n = vectors.length;
  const step = n / MAX_VECTORS;
  const picks = Array.from({ length: MAX_VECTORS }, (_, j) => Math.floor(j * step));
  const weight = (i: number) => options.weights?.[i] ?? 1;
  const groupWeight = picks.map((from, j) => {
    let sum = 0;
    for (let i = from; i < (picks[j + 1] ?? n); i++) sum += weight(i);
    return sum;
  });
  const sample = picks.map((i) => vectors[i]);
  const labels = clusterAll(sample, { ...options, weights: groupWeight });
  const k = Math.max(...labels) + 1;
  const centres = Array.from({ length: k }, () => new Float32Array(normalize(sample[0]).length));
  sample.forEach((v, j) => {
    const u = normalize(v);
    for (let d = 0; d < u.length; d++) centres[labels[j]][d] += u[d] * groupWeight[j];
  });
  const units = centres.map(normalize);
  return renumber(vectors.map((v) => {
    const u = normalize(v);
    let best = 0;
    for (let c = 1; c < k; c++) if (cosineDistance(u, units[c]) < cosineDistance(u, units[best])) best = c;
    return best;
  }));
}

function clusterAll(vectors: ArrayLike<number>[], { threshold = 0.5, count, minWeight = 0, weights }: ClusterOptions): number[] {
  const n = vectors.length;
  if (n === 0) return [];
  const unit = vectors.map(normalize);
  const w = Array.from({ length: n }, (_, i) => Math.max(1e-6, weights?.[i] ?? 1));

  // distances between clusters, merged into the lower index on every step
  const d = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) d[i * n + j] = d[j * n + i] = cosineDistance(unit[i], unit[j]);
  const alive = new Array<boolean>(n).fill(true);
  const members: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const weight = [...w];
  // each cluster's closest other cluster, kept up to date instead of rescanning everything
  const nn = new Int32Array(n).fill(-1);
  const nd = new Float32Array(n).fill(Infinity);
  const scan = (i: number) => {
    nn[i] = -1;
    nd[i] = Infinity;
    for (let j = 0; j < n; j++) if (j !== i && alive[j] && d[i * n + j] < nd[i]) [nn[i], nd[i]] = [j, d[i * n + j]];
  };
  for (let i = 0; i < n; i++) scan(i);

  let left = n;
  const target = count && count > 0 ? Math.min(count, n) : 1;
  while (left > target) {
    let a = -1;
    for (let i = 0; i < n; i++) if (alive[i] && nn[i] >= 0 && (a < 0 || nd[i] < nd[a])) a = i;
    if (a < 0) break;
    if (!count && nd[a] > threshold) break;
    const b = nn[a];
    const [keep, drop] = a < b ? [a, b] : [b, a];
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === keep || k === drop) continue;
      const v = (weight[keep] * d[keep * n + k] + weight[drop] * d[drop * n + k]) / (weight[keep] + weight[drop]);
      d[keep * n + k] = d[k * n + keep] = v;
    }
    weight[keep] += weight[drop];
    members[keep].push(...members[drop]);
    alive[drop] = false;
    left--;
    scan(keep);
    for (let k = 0; k < n; k++) if (alive[k] && k !== keep && (nn[k] === keep || nn[k] === drop)) scan(k);
  }

  const groups = [...Array(n).keys()].filter((i) => alive[i]);
  const label = new Array<number>(n).fill(0);
  groups.forEach((g, gi) => members[g].forEach((m) => (label[m] = gi)));

  if (!count && minWeight > 0 && groups.length > 1) absorbSmall(unit, w, label, minWeight);
  return renumber(label);
}

/** Fold clusters lighter than `minWeight` into the nearest heavier cluster (by its weighted centre). */
function absorbSmall(unit: Float32Array[], w: number[], label: number[], minWeight: number) {
  const centres = new Map<number, { sum: Float32Array; weight: number }>();
  unit.forEach((v, i) => {
    const c = centres.get(label[i]) ?? { sum: new Float32Array(v.length), weight: 0 };
    for (let k = 0; k < v.length; k++) c.sum[k] += v[k] * w[i];
    c.weight += w[i];
    centres.set(label[i], c);
  });
  const big = [...centres].filter(([, c]) => c.weight >= minWeight).map(([id, c]) => ({ id, centre: normalize(c.sum) }));
  if (!big.length) return; // everything is small: leave it
  const home = new Map<number, number>();
  for (const [id, c] of centres) {
    if (c.weight >= minWeight) continue;
    const mine = normalize(c.sum);
    home.set(id, big.reduce((best, b) => (cosineDistance(mine, b.centre) < cosineDistance(mine, best.centre) ? b : best)).id);
  }
  for (let i = 0; i < label.length; i++) label[i] = home.get(label[i]) ?? label[i];
}

/** Numbers 0, 1, 2... in order of first appearance. */
function renumber(label: number[]): number[] {
  const seen = new Map<number, number>();
  return label.map((l) => {
    if (!seen.has(l)) seen.set(l, seen.size);
    return seen.get(l)!;
  });
}
