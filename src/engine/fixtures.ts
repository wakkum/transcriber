// Test data shared by the engine tests.
import type { Word } from './transcript';

/** Words one second apart (0.8 s long) from `at`. */
export const words = (text: string, at = 0): Word[] => text.split(' ').map((t, i) => ({ id: `w${at}-${i}`, text: t, start: at + i, end: at + i + 0.8 }));
