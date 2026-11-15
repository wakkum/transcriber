// The transcript as lines behind timecodes: click a word to play from it, drag or Shift+click to
// select words, double-click to correct one. With two or more speakers each paragraph is headed by
// a name button (rename, give the paragraph away, merge); a bar for the selected words does the same.
import { useEffect, useRef, useState } from 'react';
import { timecode, type Para, type Word } from '../engine/transcript';
import type { Speaker } from '../engine/speakers';
import { Dot, SpeakerList, SpeakerMenu } from './SpeakerMenu';

export type MenuState = { key: string; rename?: boolean } | null;

type Props = {
  paras: Para[];
  lines: Word[][][];
  speakers: Speaker[];
  showSpeakers: boolean;
  now: number;
  selected: ReadonlySet<string>;
  editing: string | null;
  menu: MenuState;
  onSeek: (t: number) => void;
  onSelect: (from: string, to: string) => void;
  onClear: () => void;
  onEdit: (id: string | null) => void;
  onRetype: (id: string, text: string) => void;
  onMenu: (m: MenuState) => void;
  onRename: (id: string, name: string) => void;
  onMerge: (from: string, into: string) => void;
  onGiveParagraph: (p: Para, to: string | 'new') => void;
};

export function Transcript(p: Props) {
  // dragging across words selects them; the click that ends a drag must not also seek
  const drag = useRef<{ from: string; moved: boolean } | null>(null);
  const anchor = useRef<string | null>(null);

  useEffect(() => {
    const up = () => window.setTimeout(() => (drag.current = null), 0);
    addEventListener('mouseup', up);
    return () => removeEventListener('mouseup', up);
  }, []);

  // clicking outside an open menu closes it
  useEffect(() => {
    if (!p.menu) return;
    const away = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.pop, .whobtn')) p.onMenu(null);
    };
    addEventListener('mousedown', away);
    return () => removeEventListener('mousedown', away);
  }, [p.menu, p]);

  return (
    <>
      {p.paras.map((para, i) => {
        const key = para.words[0].id;
        const speaker = p.speakers.find((s) => s.id === para.speaker);
        return (
          <section key={key} className="para">
            {p.showSpeakers && speaker && (
              <div className="whowrap">
                <button className="whobtn" onClick={() => p.onMenu(p.menu?.key === key ? null : { key })} aria-expanded={p.menu?.key === key}>
                  <Dot speakers={p.speakers} id={speaker.id} />
                  {speaker.name}
                </button>
                {p.menu?.key === key && (
                  <SpeakerMenu
                    speaker={speaker}
                    speakers={p.speakers}
                    autoRename={p.menu.rename}
                    onRename={(name) => p.onRename(speaker.id, name)}
                    onMerge={(into) => p.onMerge(speaker.id, into)}
                    onGive={(to) => p.onGiveParagraph(para, to)}
                    onClose={() => p.onMenu(null)}
                  />
                )}
              </div>
            )}
            {p.lines[i].map((line) => (
              <p key={line[0].id} className={`line${p.now >= line[0].start && p.now < line.at(-1)!.end + 0.3 ? ' now' : ''}`}>
                <button className="tc mono" onClick={() => p.onSeek(line[0].start)} title="Play from here">
                  {timecode(line[0].start)}
                </button>
                <span>
                  {line.map((w) =>
                    p.editing === w.id ? (
                      <WordInput key={w.id} text={w.text} onDone={(t) => (t == null ? p.onEdit(null) : p.onRetype(w.id, t))} />
                    ) : (
                      <span
                        key={w.id}
                        className={`w${p.selected.has(w.id) ? ' sel' : ''}`}
                        onMouseDown={(e) => {
                          if (e.button !== 0 || (e.target as HTMLElement).closest('input')) return;
                          if (e.shiftKey && anchor.current) {
                            p.onSelect(anchor.current, w.id);
                            drag.current = { from: anchor.current, moved: true };
                          } else {
                            anchor.current = w.id;
                            drag.current = { from: w.id, moved: false };
                          }
                        }}
                        onMouseEnter={(e) => {
                          if (e.buttons !== 1 || !drag.current || w.id === drag.current.from) return;
                          drag.current.moved = true;
                          p.onSelect(drag.current.from, w.id);
                        }}
                        onClick={() => {
                          if (drag.current?.moved) return;
                          p.onClear();
                          p.onSeek(w.start);
                        }}
                        onDoubleClick={() => p.onEdit(w.id)}
                      >
                        {w.text}{' '}
                      </span>
                    ),
                  )}
                </span>
              </p>
            ))}
          </section>
        );
      })}
    </>
  );
}

/** The bar for selected words: give them to a speaker (new or existing), or clear the selection. */
export function SelectionBar({ count, speakers, current, onGive, onClear }: { count: number; speakers: Speaker[]; current: string | null; onGive: (to: string | 'new') => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="selbar" role="toolbar" aria-label="Selected words">
      <span>{count === 1 ? '1 word' : `${count} words`}</span>
      <div className="whowrap">
        <button onClick={() => setOpen(!open)} aria-expanded={open}>
          Speaker ▾
        </button>
        {open && (
          <div className="pop up">
            <div className="pop-label">Give these words to</div>
            <SpeakerList
              speakers={speakers}
              checked={current}
              onPick={(to) => {
                setOpen(false);
                onGive(to);
              }}
            />
          </div>
        )}
      </div>
      <button className="ghost" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}

/** Inline box for correcting a word: Enter or clicking away keeps it, Esc cancels, empty removes the word. */
function WordInput({ text, onDone }: { text: string; onDone: (text: string | null) => void }) {
  const [value, setValue] = useState(text);
  // Esc unmounts the box, which can still fire a blur: answer only once
  const done = useRef(false);
  const finish = (t: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(t);
  };
  return (
    <input
      className="word-input"
      autoFocus
      value={value}
      size={Math.max(3, value.length + 1)}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value);
        if (e.key === 'Escape') finish(null);
      }}
    />
  );
}
