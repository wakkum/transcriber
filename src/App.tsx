import { useEffect, useMemo, useRef, useState } from 'react';
import { decodeToMono, WHISPER_SAMPLE_RATE } from './audio/decode';
import { assignWords, smoothSpeakers } from './engine/diarize';
import { docxFile } from './engine/docx';
import { printHtml } from './engine/html';
import { LANGUAGES, modelFor, QUALITIES, type Quality } from './engine/models';
import { canWritePdf, pdfFile, type Measure } from './engine/pdf';
import { addSpeaker, assignTo, fromIdentification, mergeSpeakers, namesOf, renameSpeaker, usedSpeakers, type Speaker } from './engine/speakers';
import { baseName, clock, isRtl, lineGroups, paragraphs, transcriptTxt, type Para, type Word } from './engine/transcript';
import { newerVersion, RELEASES_PAGE } from './engine/update';
import { SelectionBar, Transcript, type MenuState } from './ui/Transcript';
import type { DiarizeControl, DiarizeMessage, DiarizeRequest } from './workers/diarize.worker';
import type { TranscribeControl, TranscribeMessage, TranscribeRequest } from './workers/transcribe.worker';

type Phase = 'idle' | 'decoding' | 'model' | 'transcribing' | 'speakers' | 'done' | 'error';
/** How many people to look for: found automatically, a number, or not at all. */
type SpeakerSetting = 'auto' | 'off' | '2' | '3' | '4' | '5' | '6' | '7' | '8';
type Settings = { language: string; quality: Quality; device: 'wasm' | 'webgpu'; speakers: SpeakerSetting; updates: boolean };
type Snapshot = { words: Word[]; speakers: Speaker[] };

const DEFAULTS: Settings = { language: 'english', quality: 'balanced', device: 'wasm', speakers: 'auto', updates: true };
declare const __APP_VERSION__: string;
/** Only the desktop app is something to update: a browser always loads the current build. */
const IS_APP = location.protocol === 'app:';
const SETTINGS_KEY = 'transcriber.settings';
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|mpg|mpeg|3gp|ts|mts)$/i;
const ACCEPT = 'audio/*,video/*,.mkv,.mts,.ts';
const SPEAKER_MODELS = '~32 MB';
const COUNTS: SpeakerSetting[] = ['2', '3', '4', '5', '6', '7', '8'];

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Text widths for the PDF: Arial has the same widths as the PDF's Helvetica. */
const measure: Measure = (() => {
  let ctx: CanvasRenderingContext2D | null = null;
  return (text, size, bold) => {
    ctx ??= document.createElement('canvas').getContext('2d')!;
    ctx.font = `${bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
    return ctx.measureText(text).width;
  };
})();

/** The browser's print dialog for a page, from a hidden frame. */
function printPage(html: string) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
  // no scripts in the printed page; it only needs to be printed
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.srcdoc = html;
  frame.onload = () => {
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.append(frame);
}

let nextId = 0;

/** The running work. `stopped`: the user pressed Stop and the worker is finishing its current piece. */
type Job = { worker: Worker | null; abort: AbortController; stopped?: boolean };

export default function App() {
  const [settings, setSettingsState] = useState(loadSettings);
  const [phase, setPhase] = useState<Phase>('idle');
  const [stage, setStage] = useState<'download' | 'work'>('work');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState('');
  const [words, setWords] = useState<Word[]>([]);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [duration, setDuration] = useState(0);
  const [title, setTitle] = useState('');
  const [timecodes, setTimecodes] = useState(true);
  const [device, setDevice] = useState('');
  const [now, setNow] = useState(-1);
  const [editing, setEditing] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [menu, setMenu] = useState<MenuState>(null);
  const [over, setOver] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState('');
  const [update, setUpdate] = useState<string | null>(null);
  useEffect(() => {
    if (!IS_APP || !settings.updates) return setUpdate(null);
    const abort = new AbortController();
    void newerVersion(__APP_VERSION__, abort.signal).then((v) => !abort.signal.aborted && setUpdate(v));
    return () => abort.abort();
  }, [settings.updates]);
  const job = useRef<Job | null>(null);
  const mono = useRef<Float32Array | null>(null);
  const media = useRef<HTMLMediaElement | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const model = modelFor(settings.language, settings.quality);
  const busy = phase === 'decoding' || phase === 'model' || phase === 'transcribing' || phase === 'speakers';
  const isVideo = !!file && (file.type.startsWith('video/') || VIDEO.test(file.name));
  const paras = useMemo(() => paragraphs(words), [words]);
  const lines = useMemo(() => paras.map((p) => lineGroups(p.words)), [paras]);
  const rtl = useMemo(() => isRtl(words.slice(0, 400).map((w) => w.text).join(' ')), [words]);
  const showSpeakers = speakers.length >= 2;
  const index = useMemo(() => new Map(words.map((w, i) => [w.id, i])), [words]);
  const selection = useMemo(() => new Set(selected), [selected]);

  const setSettings = (s: Partial<Settings>) => {
    const next = { ...settings, ...s };
    setSettingsState(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // private window: settings just aren't remembered
    }
  };

  // leaving the page loses the transcript: ask first
  useEffect(() => {
    if (!words.length && !busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [words.length, busy]);

  useEffect(() => () => URL.revokeObjectURL(mediaUrl), [mediaUrl]);

  // Ctrl/Cmd+Z undoes an edit; Esc clears the selection and closes menus (outside text boxes)
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea, select');
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing && !busy) {
        e.preventDefault();
        undo();
      }
      if (e.key === 'Escape' && !typing) {
        setSelected([]);
        setMenu(null);
      }
    };
    addEventListener('keydown', keys);
    return () => removeEventListener('keydown', keys);
  });

  function stop() {
    job.current?.abort.abort();
    job.current?.worker?.terminate();
    job.current = null;
  }

  async function start(f: File) {
    if (busy) return;
    if (words.length && !confirm('Start a new transcript? The current one is lost unless you exported it.')) return;
    stop();
    const abort = new AbortController();
    const mine: Job = { worker: null, abort };
    job.current = mine;
    setFile(f);
    setMediaUrl(URL.createObjectURL(f));
    setTitle(baseName(f.name));
    setWords([]);
    setSpeakers([]);
    setHistory([]);
    setSelected([]);
    setMenu(null);
    setNotice('');
    setError('');
    setNow(-1);
    setProgress(0);
    setStopping(false);
    setPhase('decoding');
    let samples: Float32Array;
    try {
      samples = await decodeToMono(f, setProgress, abort.signal);
    } catch (err) {
      if (job.current !== mine) return;
      setPhase('error');
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (job.current !== mine) return;
    setDuration(samples.length / WHISPER_SAMPLE_RATE);
    // the audio now lives in the worker; it comes back with the worker's last message (one copy, not three)
    mono.current = null;
    const worker = new Worker(new URL('./workers/transcribe.worker.ts', import.meta.url), { type: 'module' });
    mine.worker = worker;
    setPhase('model');
    setProgress(0);
    const all: Word[] = [];
    const fail = (message: string) => {
      setStopping(false);
      setPhase('error');
      setError(message);
      worker.terminate();
    };
    worker.onerror = () => fail('Transcription could not start: the speech worker failed to load. Reload the page and try again.');
    worker.onmessage = (e: MessageEvent<TranscribeMessage>) => {
      if (job.current !== mine) return;
      const m = e.data;
      if (m.type === 'download') setProgress(m.progress);
      if (m.type === 'ready') {
        setDevice(m.device === 'webgpu' ? 'GPU' : 'standard engine');
        setPhase('transcribing');
        setProgress(0);
      }
      if (m.type === 'words') {
        all.push(...m.words.map((w) => ({ id: `w${nextId++}`, ...w })));
        setWords([...all]);
        setProgress(m.progress);
      }
      if (m.type === 'done') {
        mono.current = m.audio;
        worker.terminate();
        mine.worker = null;
        if (mine.stopped) {
          job.current = null;
          setStopping(false);
          setPhase('done');
          setNotice('Stopped: the transcript has the part done so far. Choose Identify speakers to find who spoke.');
        } else if (settings.speakers !== 'off' && all.length) identify(mine, all, settings.speakers === 'auto' ? undefined : Number(settings.speakers));
        else {
          setPhase('done');
          job.current = null;
        }
      }
      if (m.type === 'error') {
        if (m.audio) mono.current = m.audio;
        // "Failed to fetch" is the browser's name for a download that could not start or was cut off
        fail(/failed to fetch|networkerror|load failed/i.test(m.message) ? 'The speech model could not be downloaded. Check the internet connection and try again: the parts already downloaded are kept.' : `Transcription failed: ${m.message}`);
      }
    };
    const req: TranscribeRequest = { audio: samples, model: model.id, device: settings.device, ...(model.language ? { language: model.language } : {}) };
    worker.postMessage(req, [samples.buffer]);
  }

  /** Who spoke when, for `all` words: the segmentation and voice models in a worker, then each word takes its speaker. */
  function identify(mine: Job, all: Word[], count: number | undefined) {
    const samples = mono.current;
    if (!samples) {
      job.current = null;
      setNotice('The audio is no longer available for speaker identification: transcribe the file again.');
      return;
    }
    mono.current = null; // handed to the worker, which hands it back with its last message
    const worker = new Worker(new URL('./workers/diarize.worker.ts', import.meta.url), { type: 'module' });
    mine.worker = worker;
    setStopping(false);
    setPhase('speakers');
    setStage('download');
    setProgress(0);
    const finish = (note?: string, audio?: Float32Array) => {
      if (audio) mono.current = audio;
      worker.terminate();
      mine.worker = null;
      job.current = null;
      setStopping(false);
      setPhase('done');
      if (note) setNotice(note);
    };
    worker.onerror = () => finish('Speaker identification could not start. The transcript is complete without speakers.');
    worker.onmessage = (e: MessageEvent<DiarizeMessage>) => {
      if (job.current !== mine) return;
      const m = e.data;
      if (m.type === 'download') setProgress(m.progress);
      if (m.type === 'progress') {
        setStage('work');
        setProgress(m.progress);
      }
      if (m.type === 'result') {
        const spans = all.map((w) => ({ start: w.start, end: w.end }));
        const who = smoothSpeakers(assignWords(spans, m.segments), spans);
        const r = fromIdentification(all, who);
        setWords(r.words);
        setSpeakers(r.speakers);
        setHistory([]);
        // found automatically: say how many, since a wrong count is the likeliest mistake
        const n = r.speakers.length;
        finish(count ? '' : `Found ${n === 1 ? 'one speaker' : `${n} speakers`}. If that's not right, pick the number in the Speakers box and choose Identify again.`, m.audio);
      }
      if (m.type === 'stopped') finish('Stopped: the transcript has no speakers.', m.audio);
      if (m.type === 'error') finish(`Speaker identification failed: ${m.message} The transcript is complete without speakers.`, m.audio);
    };
    const req: DiarizeRequest = { audio: samples, words: all.map((w) => ({ start: w.start, end: w.end })), ...(count ? { speakers: count } : {}) };
    worker.postMessage(req, [samples.buffer]);
  }

  function identifyAgain() {
    if (busy || !words.length || !mono.current) return;
    if (history.length && !confirm('Identify speakers again? Your speaker names and changes are replaced.')) return;
    const abort = new AbortController();
    const mine: Job = { worker: null, abort };
    job.current = mine;
    setNotice('');
    setSelected([]);
    setMenu(null);
    identify(mine, words, settings.speakers === 'auto' || settings.speakers === 'off' ? undefined : Number(settings.speakers));
  }

  function cancel() {
    const running = job.current;
    // While recognizing or identifying, ask the worker to finish its current piece and hand the audio
    // back (so Identify speakers still works afterwards); while loading models or reading the file,
    // just stop.
    if (running?.worker && (phase === 'transcribing' || (phase === 'speakers' && stage === 'work'))) {
      running.stopped = true;
      running.worker.postMessage({ type: 'stop' } satisfies TranscribeControl & DiarizeControl);
      setStopping(true);
      return;
    }
    stop();
    mono.current = null;
    setPhase(words.length ? 'done' : 'idle');
    if (words.length) setNotice('Stopped: the transcript has what was done so far.');
  }

  function reset() {
    if (words.length && !confirm('Start over? The current transcript is lost unless you exported it.')) return;
    stop();
    mono.current = null;
    setStopping(false);
    setWords([]);
    setSpeakers([]);
    setHistory([]);
    setFile(null);
    setMediaUrl('');
    setPhase('idle');
    setError('');
    setNotice('');
  }

  // ---- edits (each one undoable) ----

  function commit(next: Partial<Snapshot>) {
    setHistory((h) => [...h.slice(-99), { words, speakers }]);
    if (next.words) setWords(next.words);
    if (next.speakers) setSpeakers(next.speakers);
  }

  function undo() {
    const last = history.at(-1);
    if (!last) return;
    setHistory(history.slice(0, -1));
    setWords(last.words);
    setSpeakers(last.speakers);
    setEditing(null);
    setMenu(null);
  }

  function retype(id: string, text: string) {
    setEditing(null);
    const clean = text.trim().replace(/\s+/g, ' ');
    const old = words.find((w) => w.id === id);
    if (!old || clean === old.text) return;
    commit({ words: clean ? words.map((w) => (w.id === id ? { ...w, text: clean } : w)) : words.filter((w) => w.id !== id) });
  }

  /** Give words to a speaker ('new' makes one and opens its name box). */
  function give(ids: ReadonlySet<string>, to: string | 'new') {
    // words with no speakers yet all belong to one: make that speaker first, so the rest keep a label
    const base = speakers.length ? { words, speakers } : fromIdentification(words, words.map(() => 0));
    let target = to;
    let list = base.speakers;
    if (to === 'new') {
      const added = addSpeaker(list);
      list = added.speakers;
      target = added.id;
    }
    const next = assignTo(base.words, ids, target);
    commit({ words: next, speakers: usedSpeakers(list, next) });
    setSelected([]);
    if (to === 'new') {
      const first = next.find((w) => ids.has(w.id));
      if (first) setMenu({ key: first.id, rename: true });
    }
  }

  function selectRange(from: string, to: string) {
    const [a, b] = [index.get(from), index.get(to)];
    if (a == null || b == null) return;
    setSelected(words.slice(Math.min(a, b), Math.max(a, b) + 1).map((w) => w.id));
  }

  function seek(t: number) {
    const m = media.current;
    if (!m) return;
    m.currentTime = t;
    void m.play();
  }

  const name = (title.trim() || 'Transcript').replace(/[\\/:*?"<>|]+/g, '-');
  const subtitle = () =>
    `Transcript of ${file?.name ?? 'a recording'} · ${clock(duration)} · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;

  function exportAs(kind: 'docx' | 'txt' | 'pdf') {
    const opts = { timecodes, rtl, ...(showSpeakers ? { speakerNames: namesOf(speakers) } : {}) };
    const t = title.trim() || 'Transcript';
    const sub = subtitle();
    if (kind === 'docx') download(docxFile(t, sub, paras, opts) as BlobPart, `${name}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    if (kind === 'txt') download(transcriptTxt(t, sub, paras, opts), `${name}.txt`, 'text/plain;charset=utf-8');
    if (kind === 'pdf') {
      const everything = `${t} ${sub} ${words.map((w) => w.text).join(' ')} ${showSpeakers ? speakers.map((s) => s.name).join(' ') : ''}`;
      if (canWritePdf(everything)) download(pdfFile(t, sub, paras, opts, measure) as BlobPart, `${name}.pdf`, 'application/pdf');
      else {
        setNotice('This text needs fonts the direct PDF lacks, so the print window opens: choose "Save as PDF" there.');
        printPage(printHtml(t, sub, paras, opts));
      }
    }
  }

  const status =
    phase === 'decoding'
      ? 'Reading the sound'
      : phase === 'model'
        ? `Loading the speech model (${model.size}, once)`
        : phase === 'transcribing'
          ? `Transcribing on the ${device}`
          : stage === 'download'
            ? `Loading the speaker models (${SPEAKER_MODELS}, once)`
            : 'Identifying speakers';

  // the speaker of every selected word, if all the same (ticked in the bar)
  const selectedSpeaker = useMemo(() => {
    const set = new Set(words.filter((w) => selection.has(w.id)).map((w) => w.speaker));
    return set.size === 1 ? ([...set][0] ?? null) : null;
  }, [words, selection]);

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f && !busy) void start(f);
      }}
    >
      <header className="top">
        <strong className="brand">Transcriber</strong>
        <span className="muted small">Audio and video to text, on this computer</span>
        {phase !== 'idle' && (
          <button className="ghost" onClick={reset} disabled={busy}>
            New file
          </button>
        )}
      </header>

      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void start(f);
        }}
      />

      {update && (
        <p className="update">
          Version {update} is available.{' '}
          <a href={RELEASES_PAGE} target="_blank" rel="noreferrer">
            Download it
          </a>
          <button onClick={() => setUpdate(null)} aria-label="Dismiss">
            ×
          </button>
        </p>
      )}

      {phase === 'idle' || (phase === 'error' && !words.length) ? (
        <main className="empty">
          <div className={`drop${over ? ' over' : ''}`}>
            <h1>Drop an audio or video file</h1>
            <p>
              MP3, WAV, M4A, MP4, MOV, WebM and more. Everything stays on this computer: nothing is uploaded. The first time, the speech model ({model.size}) and the speaker models (
              {SPEAKER_MODELS}) download once and are then kept.
            </p>
            <button className="primary" onClick={() => input.current?.click()}>
              Choose a file
            </button>
            {phase === 'error' && <p className="error">{error}</p>}
            <div className="settings">
              <label>
                Language
                <select value={settings.language} onChange={(e) => setSettings({ language: e.target.value })}>
                  {LANGUAGES.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Quality
                <select value={settings.quality} onChange={(e) => setSettings({ quality: e.target.value as Quality })}>
                  {QUALITIES.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.label} ({modelFor(settings.language, q.id).size})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Speakers
                <select value={settings.speakers} onChange={(e) => setSettings({ speakers: e.target.value as SpeakerSetting })}>
                  <option value="auto">Find automatically</option>
                  {COUNTS.map((c) => (
                    <option key={c} value={c}>
                      {c} speakers
                    </option>
                  ))}
                  <option value="off">Don&apos;t identify</option>
                </select>
              </label>
              <label>
                Engine
                <select value={settings.device} onChange={(e) => setSettings({ device: e.target.value as Settings['device'] })}>
                  <option value="wasm">Standard</option>
                  <option value="webgpu" disabled={!('gpu' in navigator)}>
                    GPU (faster, experimental)
                  </option>
                </select>
              </label>
            </div>
            {IS_APP && (
              <label className="updates">
                <input type="checkbox" checked={settings.updates} onChange={(e) => setSettings({ updates: e.target.checked })} />
                Check for new versions (asks GitHub once at launch, sends nothing else)
              </label>
            )}
          </div>
        </main>
      ) : (
        <main className="work">
          <div className="player">
            {isVideo ? (
              <video ref={(el) => void (media.current = el)} src={mediaUrl} controls playsInline onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
            ) : (
              <audio ref={(el) => void (media.current = el)} src={mediaUrl} controls onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
            )}
          </div>

          {busy && (
            <div className="progress">
              <div className="row">
                <span>{status}…</span>
                <span className="muted mono">{Math.round(progress * 100)}%</span>
                <button onClick={cancel} disabled={stopping}>
                  {stopping ? 'Stopping…' : phase === 'transcribing' || phase === 'speakers' ? 'Stop' : 'Cancel'}
                </button>
              </div>
              <div className="bar">
                <div style={{ width: `${progress * 100}%` }} />
              </div>
            </div>
          )}
          {phase === 'error' && <p className="error">{error}</p>}
          {notice && (
            <p className="notice" onClick={() => setNotice('')}>
              {notice}
            </p>
          )}

          {!busy && words.length > 0 && (
            <div className="export">
              <input className="title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" placeholder="Title" />
              <label className="check">
                <input type="checkbox" checked={timecodes} onChange={(e) => setTimecodes(e.target.checked)} />
                Timecodes
              </label>
              <span className="grow" />
              <span className="muted small">Export</span>
              <button onClick={() => exportAs('docx')}>Word</button>
              <button onClick={() => exportAs('pdf')}>PDF</button>
              <button onClick={() => exportAs('txt')}>Text</button>
              <div className="break" />
              <label className="check small">
                Speakers
                <select value={settings.speakers === 'off' ? 'auto' : settings.speakers} onChange={(e) => setSettings({ speakers: e.target.value as SpeakerSetting })}>
                  <option value="auto">Find automatically</option>
                  {COUNTS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={identifyAgain} disabled={!mono.current} title={mono.current ? undefined : 'The audio is no longer available: transcribe the file again'}>
                {speakers.length ? 'Identify again' : 'Identify speakers'}
              </button>
              <span className="grow" />
              <button className="ghost" onClick={undo} disabled={!history.length} title="Undo (Ctrl or Cmd + Z)">
                Undo
              </button>
            </div>
          )}

          <article className="transcript" dir={rtl ? 'rtl' : 'auto'}>
            {phase === 'done' && !words.length && <p className="muted">No speech was found in this file.</p>}
            <Transcript
              paras={paras}
              lines={lines}
              speakers={speakers}
              showSpeakers={showSpeakers}
              now={now}
              selected={selection}
              editing={editing}
              menu={menu}
              onSeek={seek}
              onSelect={selectRange}
              onClear={() => setSelected([])}
              onEdit={setEditing}
              onRetype={retype}
              onMenu={setMenu}
              onRename={(id, n) => commit({ speakers: renameSpeaker(speakers, id, n) })}
              onMerge={(from, into) => {
                const r = mergeSpeakers(words, speakers, from, into);
                commit(r);
                setMenu(null);
              }}
              onGiveParagraph={(p: Para, to) => give(new Set(p.words.map((w) => w.id)), to)}
            />
          </article>
          {!busy && words.length > 0 && (
            <p className="muted small hint">Click a word to play from there. Drag or Shift-click to select words and give them to a speaker. Double-click a word to correct it.</p>
          )}
          {!busy && selected.length > 0 && <SelectionBar count={selected.length} speakers={speakers} current={selectedSpeaker} onGive={(to) => give(selection, to)} onClear={() => setSelected([])} />}
        </main>
      )}
      {over && <div className="drop-cover">Drop to transcribe</div>}
    </div>
  );
}
