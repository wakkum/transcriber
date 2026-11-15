import { describe, expect, it } from 'vitest';
import { words } from './fixtures';
import { addSpeaker, assignTo, fromIdentification, mergeSpeakers, nameTaken, namesOf, renameSpeaker, usedSpeakers } from './speakers';

const two = [{ id: 's1', name: 'Speaker 1' }, { id: 's2', name: 'Speaker 2' }];

describe('addSpeaker', () => {
  it('takes the lowest unused number and a fresh id, so names never repeat after a merge', () => {
    expect(addSpeaker([]).speakers).toEqual([{ id: 's1', name: 'Speaker 1' }]);
    const afterMerge = [{ id: 's1', name: 'Speaker 1' }, { id: 's3', name: 'Speaker 3' }];
    const next = addSpeaker(afterMerge);
    expect(next.id).toBe('s2');
    expect(next.speakers.at(-1)).toEqual({ id: 's2', name: 'Speaker 2' });
    expect(addSpeaker([{ id: 's1', name: 'speaker 1 ' }]).speakers[1].name).toBe('Speaker 2');
  });
});

describe('fromIdentification', () => {
  it('names speakers and labels each word', () => {
    const r = fromIdentification(words('a b c d'), [0, 0, 1, 0]);
    expect(r.speakers).toEqual(two);
    expect(r.words.map((w) => w.speaker)).toEqual(['s1', 's1', 's2', 's1']);
    expect(fromIdentification([], [])).toEqual({ words: [], speakers: [] });
  });
});

describe('names', () => {
  it('rename trims and tidies, ignoring blanks and no-ops', () => {
    expect(renameSpeaker(two, 's1', '  Omar   Khan ')[0].name).toBe('Omar Khan');
    expect(renameSpeaker(two, 's1', '   ')).toBe(two);
    expect(renameSpeaker(two, 's1', 'Speaker 1')).toBe(two);
  });
  it('finds another speaker with the same name, ignoring case', () => {
    expect(nameTaken(two, 's1', ' speaker 2')?.id).toBe('s2');
    expect(nameTaken(two, 's2', 'Speaker 2')).toBeUndefined();
    expect(namesOf(two)).toEqual({ s1: 'Speaker 1', s2: 'Speaker 2' });
  });
});

describe('giving words away', () => {
  const ws = fromIdentification(words('a b c d e'), [0, 0, 0, 0, 0]).words;
  it('assigns just the chosen words, and returns the same array when nothing changes', () => {
    const out = assignTo(ws, new Set([ws[1].id, ws[2].id]), 's2');
    expect(out.map((w) => w.speaker)).toEqual(['s1', 's2', 's2', 's1', 's1']);
    expect(assignTo(ws, new Set([ws[0].id]), 's1')).toBe(ws);
    expect(assignTo(ws, new Set(), 's2')).toBe(ws);
  });
  it('merges one speaker into another', () => {
    const mixed = assignTo(ws, new Set([ws[3].id]), 's2');
    const r = mergeSpeakers(mixed, two, 's2', 's1');
    expect(r.words.every((w) => w.speaker === 's1')).toBe(true);
    expect(r.speakers).toEqual([two[0]]);
    expect(mergeSpeakers(mixed, two, 's1', 's1').words).toBe(mixed);
  });
  it('drops speakers who have no words left, keeping order', () => {
    expect(usedSpeakers(two, ws)).toEqual([two[0]]);
    const both = assignTo(ws, new Set([ws[0].id]), 's2');
    expect(usedSpeakers(two, both)).toBe(two);
  });
});
