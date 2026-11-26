// "How to use": a short guide in a dialog, opened from the header. Plain text, no settings.
import { useEffect, useRef } from 'react';

const STEPS: { title: string; items: string[] }[] = [
  {
    title: 'Transcribe',
    items: [
      'Drop audio or video files on the window, or choose them. You can add several: they are done one after the other, each in its own tab at the top.',
      'Pick the language and quality first. Fastest is quick, Most accurate is slower but better. Speakers: leave it on Find automatically, or give the number of people if you know it.',
      'Everything stays on your computer. The first time you use another language or quality, its model downloads once.',
    ],
  },
  {
    title: 'Listen and read along',
    items: [
      'Click a word or a timecode to play from there. If the player is paused, it only moves; it does not start.',
      'Search the transcript with the box above it (Ctrl or Cmd + F). Enter goes to the next match.',
    ],
  },
  {
    title: 'Fix the text',
    items: [
      'Double-click a word to correct it. Enter keeps it, Esc cancels, and emptying it removes the word.',
      'To change several words, drag over them, or click one and Shift-click another, or right-click a single word. A bar appears: retype them as one piece of text, delete them, or widen the selection to the whole sentence.',
      'Replace... under the search box swaps a word or phrase everywhere, or one place at a time.',
      'Underlined words (red dots) look doubtful. The "to check" button plays them one by one so you can correct them.',
      'Ctrl or Cmd + Z, or the Undo button, takes back your last change.',
    ],
  },
  {
    title: 'Fix the speakers',
    items: [
      'Click a speaker name above a paragraph to rename the speaker or give the paragraph to someone else.',
      'To change only part of a paragraph, even half a sentence, select those words and pick the speaker in the bar. "To end of turn" carries the selection on to where the speaker changes.',
      'Two people merged, or one person split in two? Move the Separation slider, or set the number in the Speakers box and choose Identify again.',
    ],
  },
  {
    title: 'Translate',
    items: [
      'Under the title, pick a language next to Translate to, then press Translate. Each paragraph gets its translation beside it, and the exports include it.',
      'Standard is free to use for anything. Better is more accurate but its licence allows non-commercial use only. Either downloads once (630 to 900 MB), then works offline.',
      'Translations are a guide to the meaning, not a finished text: mistakes in the transcript carry into them. Edit the transcript and press Translate again to redo only the changed paragraphs.',
    ],
  },
  {
    title: 'Save it',
    items: [
      'Export as Word, PDF or text with the buttons above the transcript. You can edit the title and switch timecodes on or off.',
      'The transcript lives only in this window, so export before you close it. The app asks before you leave.',
    ],
  },
];

export function Help({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="help"
      aria-labelledby="help-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()} // a click on the backdrop
    >
      <div className="help-head">
        <h2 id="help-title">How to use Transcriber</h2>
        <button className="ghost" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
      {STEPS.map((s) => (
        <section key={s.title}>
          <h3>{s.title}</h3>
          <ul>
            {s.items.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      ))}
    </dialog>
  );
}
