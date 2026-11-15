import type { Speaker } from '../engine/speakers';

/** A speaker's colour (one of six, by their place in the list). */
export const colorOf = (speakers: Speaker[], id: string | undefined) => `var(--sp${(Math.max(0, speakers.findIndex((s) => s.id === id)) % 6) + 1})`;
