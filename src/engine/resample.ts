// Any audio to mono at Whisper's 16 kHz, a chunk at a time as it is decoded, so an hour of video
// never has to sit in memory at its own rate. Each output sample is the average of the input it
// covers (a box filter): cheap, streamable, and clean enough for speech recognition.

export class MonoResampler {
  /** Input samples per output sample. */
  private readonly step: number;
  /** What is left of the current output sample's span, in input samples. */
  private left: number;
  private acc = 0;
  private weight = 0;
  private chunks: Float32Array[] = [];
  private length = 0;

  readonly to: number;

  constructor(from: number, to: number) {
    this.to = to;
    this.step = from / to;
    this.left = this.step;
  }

  /** Add one block of channels (all the same length). */
  push(channels: Float32Array[]) {
    const n = channels[0]?.length ?? 0;
    if (!n) return;
    const out = new Float32Array(Math.ceil(n / this.step) + 2);
    let k = 0;
    const scale = 1 / channels.length;
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (const ch of channels) x += ch[i];
      x *= scale;
      // spread this input sample over the output samples it overlaps
      let rest = 1;
      while (rest > 1e-9) {
        const take = Math.min(rest, this.left);
        this.acc += x * take;
        this.weight += take;
        rest -= take;
        this.left -= take;
        if (this.left <= 1e-9) {
          out[k++] = this.acc / this.weight;
          this.acc = 0;
          this.weight = 0;
          this.left += this.step;
        }
      }
    }
    this.add(out.subarray(0, k));
  }

  /** Add `seconds` of silence (a sound track that starts after the video does). */
  pushSilence(seconds: number) {
    const n = Math.round(seconds * this.to);
    if (n > 0) this.add(new Float32Array(n));
  }

  /** Output samples held so far. */
  get size() {
    return this.length;
  }

  /** The last `n` samples held, copied (to look for a quiet moment to cut at). */
  tail(n: number): Float32Array {
    const out = new Float32Array(Math.min(n, this.length));
    let at = out.length;
    for (let i = this.chunks.length - 1; i >= 0 && at > 0; i--) {
      const c = this.chunks[i];
      const part = c.subarray(Math.max(0, c.length - at));
      at -= part.length;
      out.set(part, at);
    }
    return out;
  }

  /** Remove and return the first `n` samples held. */
  take(n: number): Float32Array {
    const out = new Float32Array(Math.min(n, this.length));
    let at = 0;
    while (at < out.length) {
      const c = this.chunks[0];
      const need = out.length - at;
      if (c.length <= need) {
        out.set(c, at);
        at += c.length;
        this.chunks.shift();
      } else {
        out.set(c.subarray(0, need), at);
        this.chunks[0] = c.subarray(need);
        at += need;
      }
    }
    this.length -= out.length;
    return out;
  }

  /** Everything so far as one array, including a last partly filled sample. */
  finish(): Float32Array {
    if (this.weight > 1e-9) {
      this.add(Float32Array.of(this.acc / this.weight));
      this.acc = 0;
      this.weight = 0;
    }
    const all = new Float32Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      all.set(c, at);
      at += c.length;
    }
    this.chunks = [all];
    return all;
  }

  private add(c: Float32Array) {
    if (!c.length) return;
    this.chunks.push(c);
    this.length += c.length;
  }
}

export type Hole = {
  /** Seconds of audio that come before the hole (0 for a late start). */
  at: number;
  /** How long it is, in seconds. */
  gap: number;
};

/**
 * Where a sound track has holes: it starts late, or its packets jump ahead (dropped packets,
 * spliced segments). The decoder hands back continuous audio either way, so without silence
 * put back at these points every later word would be timestamped too early against the video.
 * Overlaps and tiny gaps (codec rounding) count for nothing. `packets` are in order.
 */
export function findHoles(packets: Iterable<{ timestamp: number; duration: number }>, tolerance = 0.04): Hole[] {
  const holes: Hole[] = [];
  let expected = 0; // where the next packet should start if there were no hole
  let heard = 0; // seconds of audio before it
  for (const p of packets) {
    const gap = p.timestamp - expected;
    if (gap > tolerance) holes.push({ at: heard, gap });
    expected = Math.max(expected, p.timestamp) + p.duration;
    heard += p.duration;
  }
  return holes;
}
