// The popover over a paragraph's speaker name: rename them, give this paragraph to someone else,
// or merge them into another speaker. Also the list used by the selection bar (`SpeakerList`).
import { useEffect, useRef, useState } from 'react';
import { nameTaken, type Speaker } from '../engine/speakers';
import { colorOf } from './colors';

export function Dot({ speakers, id }: { speakers: Speaker[]; id: string | undefined }) {
  return <i className="dot" style={{ background: colorOf(speakers, id) }} />;
}

/** Speakers to pick from, `checked` ticked, then "New speaker". */
export function SpeakerList({ speakers, checked, onPick, skip, newLabel = 'New speaker' }: { speakers: Speaker[]; checked?: string | null; onPick: (id: string | 'new') => void; skip?: string; newLabel?: string }) {
  return (
    <>
      {speakers
        .filter((s) => s.id !== skip)
        .map((s) => (
          <button key={s.id} className="item" onClick={() => onPick(s.id)}>
            <Dot speakers={speakers} id={s.id} />
            {s.name}
            {checked === s.id && <span className="tick">✓</span>}
          </button>
        ))}
      <button className="item" onClick={() => onPick('new')}>
        <span className="plus">+</span>
        {newLabel}
      </button>
    </>
  );
}

export function SpeakerMenu({ speaker, speakers, autoRename, onRename, onMerge, onGive, onClose }: {
  speaker: Speaker;
  speakers: Speaker[];
  /** Open with the name box focused (right after "New speaker"). */
  autoRename?: boolean;
  onRename: (name: string) => void;
  onMerge: (into: string) => void;
  onGive: (to: string | 'new') => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(speaker.name);
  const box = useRef<HTMLInputElement>(null);
  const taken = nameTaken(speakers, speaker.id, name);
  useEffect(() => {
    if (autoRename) box.current?.select();
  }, [autoRename]);

  const save = () => {
    if (taken || !name.trim()) return;
    onRename(name);
    onClose();
  };

  return (
    <div className="pop" role="dialog" aria-label={`${speaker.name} options`} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <label className="pop-label" htmlFor="rename">
        Name
      </label>
      <div className="pop-row">
        <input
          id="rename"
          ref={box}
          autoFocus={autoRename}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <button className="primary" disabled={!!taken || !name.trim()} onClick={save}>
          Save
        </button>
      </div>
      {taken && (
        <p className="pop-note">
          {taken.name} is already used.{' '}
          <button className="link" onClick={() => onMerge(taken.id)}>
            Merge {speaker.name} into {taken.name}
          </button>
        </p>
      )}
      <div className="pop-label">Give this paragraph to</div>
      <SpeakerList
        speakers={speakers}
        skip={speaker.id}
        onPick={(to) => {
          onGive(to);
          if (to !== 'new') onClose();
        }}
      />
      {speakers.length > 1 && (
        <>
          <div className="pop-label">Same person as</div>
          {speakers
            .filter((s) => s.id !== speaker.id)
            .map((s) => (
              <button
                key={s.id}
                className="item"
                onClick={() => {
                  onMerge(s.id);
                  onClose();
                }}
              >
                <Dot speakers={speakers} id={s.id} />
                Merge into {s.name}
              </button>
            ))}
        </>
      )}
    </div>
  );
}
