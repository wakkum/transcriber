// Words worth a second look. Whisper gives no certainty for a word, so this goes by signs of trouble:
// a word spoken over (nearly) silence, a word too short or too fast to say, and the same word or phrase
// looping over and over (a known failure on noise). A hint to check the audio, not proof of a mistake.
import { normalize } from './search';

export type Timed = { text: string; start: number; end: number };

/** Below this share of sound under a word, it was probably not spoken there. */
export const MIN_SOUND_SHARE = 0.3;
const MAX_CHARS_PER_SECOND = 70;

/** `sound[i]` is the share of word i's time with sound in it (see `soundShare`). */
export function doubtful(words: Timed[], sound: number[]): boolean[] {
  const flags = words.map((w, i) => {
    const chars = normalize(w.text).length;
    const dur = w.end - w.start;
    if (sound[i] < MIN_SOUND_SHARE) return true;
    if (chars >= 3 && dur < 0.05) return true;
    return chars >= 5 && dur > 0 && chars / dur > MAX_CHARS_PER_SECOND;
  });
  const keys = words.map((w) => normalize(w.text));
  // a word said 4 times in a row, or a phrase of 2 or 3 words 3 times: the first two are fine, the rest are doubtful
  for (let n = 1; n <= 3; n++) {
    const times = n === 1 ? 4 : 3;
    for (let i = 0; i + n * times <= words.length; i++) {
      const same = (a: number, b: number) => keys.slice(a, a + n).every((k, j) => k && k === keys[b + j]);
      if (!Array.from({ length: times - 1 }, (_, k) => k + 1).every((k) => same(i, i + k * n))) continue;
      let at = i + 2 * n;
      while (at + n <= words.length && same(i, at)) {
        for (let j = 0; j < n; j++) flags[at + j] = true;
        at += n;
      }
      i = at - 1;
    }
  }
  return flags;
}

/** What Whisper tends to write over sound that is not speech (video endings, subtitle credits, bare fillers). */
const INVENTED = [
  'thanks for watching',
  'thank you for watching',
  'thank you so much for watching',
  'thanks for watching and see you in the next video',
  'please subscribe',
  'like and subscribe',
  'subscribe to my channel',
  'see you in the next video',
  'see you next time',
  'bye',
  'bye bye',
  'thank you',
  'thanks',
  'you',
  'subtitles by the amaraorg community',
  'subtitled by the amaraorg community',
  'transcribed by',
  'music',
  'applause',
  // other languages it does the same in
  'اشتركوا في القناة',
  'ترجمة نانسي قنقر',
  'شكرا للمشاهدة',
  'merci davoir regarde cette video',
  'sous titres realises par la communaute damaraorg',
  'gracias por ver el video',
  'subtitulos realizados por la comunidad de amaraorg',
].map(normalize);

/**
 * Text Whisper made up over sound with no speech in it: a stretch whose words all sit over near silence,
 * or a known stock phrase ("Thanks for watching") over quiet or very sparse sound. Left out of the transcript.
 * `seconds` is the length of the stretch that was transcribed.
 */
export function inventedStretch(words: Timed[], sound: number[], seconds: number): boolean {
  if (!words.length) return false;
  if (sound.every((s) => s < MIN_SOUND_SHARE)) return true;
  const text = words.map((w) => normalize(w.text)).join('');
  const quiet = sound.reduce((a, b) => a + b, 0) / sound.length < 0.6;
  const sparse = words.length / Math.max(seconds, 1) < 0.25;
  return INVENTED.includes(text) && (quiet || sparse);
}

/** A whole recording with only a few words in it (at most 6, under one every 7 seconds): nearly always Whisper making things up over sound with no speech. */
export const sparseRecording = (words: number, seconds: number) => words > 0 && words <= 6 && words / Math.max(seconds, 1) < 0.15;
