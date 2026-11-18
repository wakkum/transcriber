import { useEffect, useMemo, useRef, useState } from 'react';
import { decodePieces, PIECE_SECONDS, WHISPER_SAMPLE_RATE } from './audio/decode';
import { assignWords, DEFAULT_SEPARATION, joinVoices, labelVoices, overlapFlags, SEPARATION_LEVELS, shiftVoices, smoothSpeakers, type Voices } from './engine/diarize';
import { docxFile } from './engine/docx';
import { printHtml } from './engine/html';
import { BUNDLED_SPEECH_MODEL, LANGUAGES, modelFor, QUALITIES, type Quality } from './engine/models';
import { canWritePdf, pdfFile, type Measure } from './engine/pdf';
import { addSpeaker, assignTo, fromIdentification, mergeSpeakers, namesOf, renameSpeaker, usedSpeakers, type Speaker } from './engine/speakers';
import { baseName, clock, isRtl, lineGroups, paragraphs, transcriptTxt, type Para, type Word } from './engine/transcript';
import { deleteWords, replaceWords, textOf, toEndOfTurn, wholeSentences } from './engine/edit';
import { findMatches, replaceAll, replaceMatch } from './engine/search';
import { newerVersion, RELEASES_PAGE } from './engine/update';
import { SelectionBar, Transcript, type MenuState } from './ui/Transcript';
import type { DiarizeControl, DiarizeMessage, DiarizeRequest } from './workers/diarize.worker';
import type { TranscribeControl, TranscribeMessage, TranscribeRequest } from './workers/transcribe.worker';

type Phase = 'idle' | 'queued' | 'decoding' | 'model' | 'transcribing' | 'speakers' | 'done' | 'error';
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
let nextDoc = 0;

/** The running work (one file at a time). `stopped`: the user pressed Stop and the worker is finishing its current piece. */
type Job = { id: number; worker: Worker | null; abort: AbortController; stopped?: boolean };

/** What a file was added with: later changes to the settings do not affect files already waiting. */
type Config = { model: ReturnType<typeof modelFor>; device: Settings['device']; speakers: SpeakerSetting };

/** One file in the list: waiting, being worked on, or done, with its own transcript and edits. */
type Doc = {
  id: number;
  file: File | null;
  config: Config;
  title: string;
  phase: Phase;
  stage: 'download' | 'work';
  progress: number;
  error: string;
  words: Word[];
  speakers: Speaker[];
  history: Snapshot[];
  duration: number;
  notice: string;
  device: string;
  stopping: boolean;
  /** Who is who, kept so the grouping can be redone instantly (null: speakers not identified). */
  voices: Voices | null;
  /** The Separation slider: an index into SEPARATION_LEVELS. */
  separation: number;
  /** Which piece of a long file is being worked on, of about how many. */
  part: number;
  parts: number;
};

const newDoc = (file: File | null, config: Config): Doc => ({
  id: file ? nextDoc++ : -1,
  file,
  config,
  title: file ? baseName(file.name) : '',
  phase: file ? 'queued' : 'idle',
  stage: 'work',
  progress: 0,
  error: '',
  words: [],
  speakers: [],
  history: [],
  duration: 0,
  notice: '',
  device: '',
  stopping: false,
  voices: null,
  separation: DEFAULT_SEPARATION,
  part: 0,
  parts: 1,
});

/** How long a piece of a long file is (seconds). `transcriber.pieceSeconds` in local storage changes it, to test with short files. */
function pieceLength() {
  try {
    const v = Number(localStorage.getItem('transcriber.pieceSeconds'));
    return v >= 10 ? v : PIECE_SECONDS;
  } catch {
    return PIECE_SECONDS;
  }
}

const working = (p: Phase) => p === 'decoding' || p === 'model' || p === 'transcribing' || p === 'speakers';

export default function App() {
  const [settings, setSettingsState] = useState(loadSettings);
  const [docs, setDocs] = useState<Doc[]>([]);
  /** The file on show (null: the start screen, to add more files). */
  const [viewId, setViewId] = useState<number | null>(null);
  const [mediaUrl, setMediaUrl] = useState('');
  const [timecodes, setTimecodes] = useState(true);
  const [now, setNow] = useState(-1);
  const [editing, setEditing] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [menu, setMenu] = useState<MenuState>(null);
  const [over, setOver] = useState(false);
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [markOverlap, setMarkOverlap] = useState(true);
  const [sepDraft, setSepDraft] = useState<number | null>(null);
  const lastCheck = useRef('');
  const [update, setUpdate] = useState<string | null>(null);
  useEffect(() => {
    if (!IS_APP || !settings.updates) return setUpdate(null);
    const abort = new AbortController();
    void newerVersion(__APP_VERSION__, abort.signal).then((v) => !abort.signal.aborted && setUpdate(v));
    return () => abort.abort();
  }, [settings.updates]);
  const job = useRef<Job | null>(null);
  /** The audio of the file worked on last (it comes back from the workers); `monoOf` is whose it is. */
  const mono = useRef<Float32Array | null>(null);
  const monoOf = useRef(-1);
  const media = useRef<HTMLMediaElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  // the key handler is set up once per render but reads these, so it always acts on the latest selection
  const selectionRef = useRef<string[]>([]);
  const deleteRef = useRef<() => void>(() => {});

  const model = modelFor(settings.language, settings.quality);
  /** In the desktop app this speech model and the speaker models are inside the app: nothing to download. */
  const included = (id: string) => IS_APP && id === BUNDLED_SPEECH_MODEL;

  const patch = (id: number, p: Partial<Doc>) => setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, ...p } : d)));
  const cur = docs.find((d) => d.id === viewId) ?? null;
  const { file, title, phase, stage, progress, error, words, speakers, history, duration, notice, device, stopping, part, parts } = cur ?? newDoc(null, { model, device: settings.device, speakers: settings.speakers });
  const cfg = cur?.config ?? { model, device: settings.device, speakers: settings.speakers };
  /** Changes to the file on show. */
  const edit = (p: Partial<Doc>) => viewId != null && patch(viewId, p);
  const setNotice = (notice: string) => edit({ notice });
  const setTitle = (title: string) => edit({ title });

  const busy = working(phase);
  const anyWork = docs.some((d) => working(d.phase));
  const isVideo = !!file && (file.type.startsWith('video/') || VIDEO.test(file.name));
  const paras = useMemo(() => paragraphs(words), [words]);
  const lines = useMemo(() => paras.map((p) => lineGroups(p.words)), [paras]);
  const rtl = useMemo(() => isRtl(words.slice(0, 400).map((w) => w.text).join(' ')), [words]);
  const showSpeakers = speakers.length >= 2;
  const index = useMemo(() => new Map(words.map((w, i) => [w.id, i])), [words]);
  const selection = useMemo(() => new Set(selected), [selected]);
  selectionRef.current = selected;
  const matches = useMemo(() => findMatches(words, query, replaceOpen), [words, query, replaceOpen]);
  const doubtful = useMemo(() => words.filter((w) => w.doubt).length, [words]);
  const talkedOver = useMemo(() => words.some((w) => w.overlap), [words]);
  const at = matches.length ? Math.min(hit, matches.length - 1) : 0;
  const found = useMemo(() => new Set(matches.flat()), [matches]);
  const foundNow = useMemo(() => new Set(matches[at] ?? []), [matches, at]);

  const setSettings = (s: Partial<Settings>) => {
    const next = { ...settings, ...s };
    setSettingsState(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // private window: settings just aren't remembered
    }
  };

  // leaving the page loses every transcript: ask first
  const unsaved = docs.some((d) => d.words.length > 0 || d.phase === 'queued' || working(d.phase));
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [unsaved]);

  // The "Drop to transcribe" cover shows while a file is dragged over the window. Leaving the window,
  // dropping elsewhere or cancelling can all skip a dragleave, so it also goes away when the drag
  // events stop coming (dragover repeats about every 50 to 350 ms while a drag is over the page).
  useEffect(() => {
    let timer = 0;
    const hide = () => {
      clearTimeout(timer);
      setOver(false);
    };
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setOver(true);
      clearTimeout(timer);
      timer = window.setTimeout(hide, 500);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) hide(); // the drag left the window
    };
    const keys = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    addEventListener('dragover', over);
    addEventListener('dragleave', leave);
    addEventListener('drop', hide);
    addEventListener('dragend', hide);
    addEventListener('pointerdown', hide);
    addEventListener('blur', hide);
    addEventListener('keydown', keys);
    return () => {
      hide();
      removeEventListener('dragover', over);
      removeEventListener('dragleave', leave);
      removeEventListener('drop', hide);
      removeEventListener('dragend', hide);
      removeEventListener('pointerdown', hide);
      removeEventListener('blur', hide);
      removeEventListener('keydown', keys);
    };
  }, []);

  // the player for the file on show
  useEffect(() => {
    if (!file) return setMediaUrl('');
    const url = URL.createObjectURL(file);
    setMediaUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // another file on show: nothing selected, open or searched
  useEffect(() => {
    setNow(-1);
    setSelected([]);
    setMenu(null);
    setEditing(null);
    setQuery('');
    setHit(0);
  }, [viewId]);

  // the match being looked at scrolls into view
  useEffect(() => {
    const id = matches[at]?.[0];
    if (id) document.querySelector(`[data-w="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // only when the match changes, not when words are corrected under it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, query, viewId]);

  // Ctrl/Cmd+Z undoes an edit, Ctrl/Cmd+F searches; Esc clears the selection and closes menus (outside text boxes)
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea, select');
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing && !busy) {
        e.preventDefault();
        undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && searchBox.current) {
        e.preventDefault();
        searchBox.current.focus();
        searchBox.current.select();
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && !busy && selectionRef.current.length) {
        e.preventDefault();
        deleteRef.current();
      }
      if (e.key === 'Escape' && !typing) {
        setSelected([]);
        setMenu(null);
      }
    };
    addEventListener('keydown', keys);
    return () => removeEventListener('keydown', keys);
  });

  // the queue: when nothing is being worked on, the next waiting file starts
  useEffect(() => {
    if (job.current) return;
    const next = docs.find((d) => d.phase === 'queued' && d.file);
    if (next) void run(next);
  });

  function stop() {
    job.current?.abort.abort();
    job.current?.worker?.terminate();
    job.current = null;
  }

  /** Add files to the list; they are worked on one after the other. */
  function add(files: File[]) {
    if (!files.length) return;
    const fresh = files.map((f) => newDoc(f, { model, device: settings.device, speakers: settings.speakers }));
    const idle = !anyWork && !docs.some((d) => d.phase === 'queued');
    setDocs((ds) => [...ds, ...fresh]);
    if (viewId == null || idle) setViewId(fresh[0].id);
  }

  /** Take a file off the list (stopping it first if it is being worked on). */
  function remove(id: number) {
    const d = docs.find((x) => x.id === id);
    if (!d) return;
    if (d.words.length && !confirm(`Remove ${d.file?.name ?? 'this file'}? Its transcript is lost unless you exported it.`)) return;
    if (job.current?.id === id) {
      stop();
      mono.current = null;
    }
    setDocs((ds) => ds.filter((x) => x.id !== id));
    if (viewId === id) setViewId(neighbour(id));
  }

  /** The tab to show when `id` goes: the next one, or the one before if it was last; none (the start screen) if it was the only one. */
  function neighbour(id: number): number | null {
    const i = docs.findIndex((x) => x.id === id);
    return (docs[i + 1] ?? docs[i - 1])?.id ?? null;
  }

  function retry(id: number) {
    patch(id, { phase: 'queued', error: '', progress: 0 });
  }

  /** Run the two workers on one piece of audio at a time. Each resolves when its worker is done (the audio comes back with it). */
  function makeWorkers(mine: Job, all: Word[]) {
    const p = (x: Partial<Doc>) => patch(mine.id, x);
    const gone = (resolve: () => void) => mine.abort.signal.addEventListener('abort', resolve, { once: true });

    /** Words of `audio` (which starts `offset` seconds into the recording) join `all` as they are found. */
    const transcribe = (audio: Float32Array, offset: number, overall: (f: number) => number, config: Config) =>
      new Promise<{ audio: Float32Array | null; error?: string }>((resolve) => {
        const worker = new Worker(new URL('./workers/transcribe.worker.ts', import.meta.url), { type: 'module' });
        mine.worker = worker;
        gone(() => resolve({ audio: null }));
        p({ phase: 'model', progress: 0 });
        const end = (r: { audio: Float32Array | null; error?: string }) => {
          worker.terminate();
          mine.worker = null;
          resolve(r);
        };
        worker.onerror = () => end({ audio: null, error: 'Transcription could not start: the speech worker failed to load. Reload the page and try again.' });
        worker.onmessage = (e: MessageEvent<TranscribeMessage>) => {
          if (job.current !== mine) return;
          const m = e.data;
          if (m.type === 'download') p({ progress: m.progress });
          if (m.type === 'ready') p({ device: m.device === 'webgpu' ? 'GPU' : 'standard engine', phase: 'transcribing', progress: overall(0) });
          if (m.type === 'words') {
            all.push(...m.words.map((w) => ({ id: `w${nextId++}`, ...w, start: w.start + offset, end: w.end + offset })));
            p({ words: [...all], progress: overall(m.progress) });
          }
          if (m.type === 'done') end({ audio: m.audio });
          if (m.type === 'error') {
            // "Failed to fetch" is the browser's name for a download that could not start or was cut off
            end({ audio: m.audio ?? null, error: /failed to fetch|networkerror|load failed/i.test(m.message) ? 'The speech model could not be downloaded. Check the internet connection and try again: the parts already downloaded are kept.' : `Transcription failed: ${m.message}` });
          }
        };
        const req: TranscribeRequest = { audio, model: config.model.id, device: config.device, ...(config.model.language ? { language: config.model.language } : {}) };
        worker.postMessage(req, [audio.buffer]);
      });

    /** The voices in `audio`, given where its words are (seconds from its start). */
    const diarize = (audio: Float32Array, spans: { start: number; end: number }[], overall: (f: number) => number) =>
      new Promise<{ audio: Float32Array | null; voices?: Voices; stopped?: boolean; error?: string }>((resolve) => {
        const worker = new Worker(new URL('./workers/diarize.worker.ts', import.meta.url), { type: 'module' });
        mine.worker = worker;
        gone(() => resolve({ audio: null }));
        p({ stopping: false, phase: 'speakers', stage: 'download', progress: 0 });
        const end = (r: { audio: Float32Array | null; voices?: Voices; stopped?: boolean; error?: string }) => {
          worker.terminate();
          mine.worker = null;
          resolve(r);
        };
        worker.onerror = () => end({ audio: null, error: 'Speaker identification could not start.' });
        worker.onmessage = (e: MessageEvent<DiarizeMessage>) => {
          if (job.current !== mine) return;
          const m = e.data;
          if (m.type === 'download') p({ progress: m.progress });
          if (m.type === 'progress') p({ stage: 'work', progress: overall(m.progress) });
          if (m.type === 'result') end({ audio: m.audio, voices: m.voices });
          if (m.type === 'stopped') end({ audio: m.audio, stopped: true });
          if (m.type === 'error') end({ audio: m.audio ?? null, error: `Speaker identification failed: ${m.message}` });
        };
        const req: DiarizeRequest = { audio, words: spans };
        worker.postMessage(req, [audio.buffer]);
      });

    return { transcribe, diarize };
  }

  /** Transcribe, then find the speakers of, a file, a piece of about half an hour at a time. */
  async function run(d: Doc) {
    const f = d.file;
    if (!f) return;
    const id = d.id;
    const abort = new AbortController();
    const mine: Job = { id, worker: null, abort };
    job.current = mine;
    mono.current = null;
    monoOf.current = id;
    const p = (x: Partial<Doc>) => patch(id, x);
    const length = pieceLength();
    const all: Word[] = [];
    const voices: Voices[] = [];
    const wantSpeakers = d.config.speakers !== 'off';
    const count = d.config.speakers === 'auto' || d.config.speakers === 'off' ? undefined : Number(d.config.speakers);
    const { transcribe, diarize } = makeWorkers(mine, all);
    const failedParts: number[] = [];
    let problem = '';
    let kept: Float32Array | null = null;
    let stoppedEarly = false;
    let stoppedSpeakers = false;
    let decoding = true;
    p({ phase: 'decoding', progress: 0, error: '', notice: '', stopping: false, words: [], speakers: [], history: [], voices: null, part: 0, parts: 1 });
    const pieces = decodePieces(f, (v) => decoding && p({ progress: v }), abort.signal, length);
    const fail = (message: string) => {
      void pieces.return(undefined);
      mine.worker?.terminate();
      mine.worker = null;
      if (job.current === mine) job.current = null;
      p({ stopping: false, phase: 'error', error: message });
    };
    try {
      for (;;) {
        decoding = true;
        p({ phase: 'decoding' });
        const next = await pieces.next();
        decoding = false;
        if (job.current !== mine) return;
        if (next.done) break;
        const piece = next.value;
        const seconds = piece.audio.length / WHISPER_SAMPLE_RATE;
        const total = piece.total || piece.start + seconds;
        const overall = (frac: number) => Math.min(1, (piece.start + frac * seconds) / total);
        p({ duration: piece.start + seconds, part: piece.index + 1, parts: Math.max(1, Math.ceil(total / length)) });
        const before = all.length;
        const t = await transcribe(piece.audio, piece.start, overall, d.config);
        if (job.current !== mine) return;
        if (t.error) return fail(t.error);
        let audio = t.audio;
        if (mine.stopped) {
          stoppedEarly = true;
          kept = piece.index === 0 && piece.last ? audio : null;
          break;
        }
        if (wantSpeakers && audio && all.length > before) {
          const local = all.slice(before).map((w) => ({ start: w.start - piece.start, end: w.end - piece.start }));
          const r = await diarize(audio, local, overall);
          if (job.current !== mine) return;
          audio = r.audio;
          if (r.voices) voices.push(shiftVoices(r.voices, piece.start));
          else if (r.stopped) stoppedSpeakers = true;
          else {
            failedParts.push(piece.index + 1);
            problem = r.error ?? '';
          }
        }
        if (piece.index === 0 && piece.last) kept = audio;
        if (stoppedSpeakers || piece.last) break;
      }
    } catch (err) {
      if (job.current !== mine) return;
      return fail(err instanceof Error ? err.message : String(err));
    }
    void pieces.return(undefined);
    mono.current = kept;
    monoOf.current = id;
    let notice = '';
    const joined = joinVoices(voices);
    let result: Partial<Doc> = {};
    if (stoppedEarly) notice = `Stopped: the transcript has the part done so far.${kept ? ' Choose Identify speakers to find who spoke.' : ''}`;
    else if (stoppedSpeakers) notice = 'Stopped: the transcript has no speakers.';
    else if (joined.vectors.length) {
      const r = applyVoices(all, joined, count, DEFAULT_SEPARATION);
      result = { words: r.words, speakers: r.speakers, voices: joined, separation: DEFAULT_SEPARATION, history: [] };
      // found automatically: say how many, since a wrong count is the likeliest mistake
      if (!count) notice = `Found ${r.speakers.length === 1 ? 'one speaker' : `${r.speakers.length} speakers`}. If that's not right, pick the number in the Speakers box and choose Identify again, or move the Separation slider.`;
      if (failedParts.length) notice += ` Speakers could not be found for part ${failedParts.join(', ')}.`;
    } else if (failedParts.length) notice = `${problem || 'Speaker identification failed.'} The transcript is complete without speakers.`;
    job.current = null;
    p({ ...result, phase: 'done', stopping: false, notice });
  }

  /** Name the people in `all` from the voices: grouping, each word's speaker, and the words spoken over. */
  function applyVoices(all: Word[], voices: Voices, count: number | undefined, level: number) {
    const { segments } = labelVoices(voices, { count, threshold: SEPARATION_LEVELS[level] });
    const spans = all.map((w) => ({ start: w.start, end: w.end }));
    const who = smoothSpeakers(assignWords(spans, segments), spans);
    const r = fromIdentification(all, who);
    const over = overlapFlags(spans, voices.overlaps);
    return { words: r.words.map((w, i) => ({ ...w, overlap: over[i] || undefined })), speakers: r.speakers };
  }

  /** The audio of the file on show is still here (only a file of one piece, worked on last, keeps it). */
  const haveAudio = mono.current != null && monoOf.current === viewId;

  /** Group the voices again with another count or separation: instant, no models. */
  function regroup(level: number, count: number | undefined): boolean {
    if (!cur?.voices) return false;
    if (history.length && !confirm('Group the voices again? Your speaker names and changes are replaced.')) return false;
    const r = applyVoices(words, cur.voices, count, level);
    edit({ words: r.words, speakers: r.speakers, history: [], separation: level, notice: count ? '' : `Found ${r.speakers.length === 1 ? 'one speaker' : `${r.speakers.length} speakers`}.` });
    setSelected([]);
    setMenu(null);
    return true;
  }

  const fixedCount = settings.speakers === 'auto' || settings.speakers === 'off' ? undefined : Number(settings.speakers);

  /** The Separation slider was let go: group the voices again at that level (asks first if edits would be lost). */
  function commitSeparation() {
    const level = sepDraft;
    setSepDraft(null);
    if (level != null && cur && level !== cur.separation) regroup(level, undefined);
  }

  function identifyAgain() {
    if (viewId == null || anyWork || !words.length) return;
    if (cur?.voices) {
      regroup(cur.separation, fixedCount);
      return;
    }
    const audio = mono.current;
    if (!audio || monoOf.current !== viewId) return;
    if (history.length && !confirm('Identify speakers again? Your speaker names and changes are replaced.')) return;
    const mine: Job = { id: viewId, worker: null, abort: new AbortController() };
    job.current = mine;
    mono.current = null; // handed to the worker, which hands it back
    setNotice('');
    setSelected([]);
    setMenu(null);
    const id = viewId;
    const all = words;
    void (async () => {
      const { diarize } = makeWorkers(mine, []);
      const r = await diarize(audio, all.map((w) => ({ start: w.start, end: w.end })), (x) => x);
      if (job.current !== mine) return;
      mono.current = r.audio;
      monoOf.current = id;
      job.current = null;
      if (r.voices) {
        const x = applyVoices(all, r.voices, fixedCount, DEFAULT_SEPARATION);
        patch(id, { words: x.words, speakers: x.speakers, voices: r.voices, separation: DEFAULT_SEPARATION, history: [], phase: 'done', stopping: false, notice: fixedCount ? '' : `Found ${x.speakers.length === 1 ? 'one speaker' : `${x.speakers.length} speakers`}.` });
      } else patch(id, { phase: 'done', stopping: false, notice: r.stopped ? 'Stopped: the transcript has no speakers.' : `${r.error ?? 'Speaker identification failed.'} The transcript is complete without speakers.` });
    })();
  }

  function cancel() {
    const running = job.current;
    if (viewId == null || running?.id !== viewId) return;
    // While recognizing or identifying, ask the worker to finish its current piece and hand the audio
    // back (so Identify speakers still works afterwards); while loading models or reading the file,
    // just stop.
    if (running.worker && (phase === 'transcribing' || (phase === 'speakers' && stage === 'work'))) {
      running.stopped = true;
      running.worker.postMessage({ type: 'stop' } satisfies TranscribeControl & DiarizeControl);
      edit({ stopping: true });
      return;
    }
    stop();
    mono.current = null;
    if (words.length) edit({ phase: 'done', stopping: false, notice: 'Stopped: the transcript has what was done so far.' });
    else {
      setDocs((ds) => ds.filter((x) => x.id !== viewId));
      setViewId(neighbour(viewId));
    }
  }

  // ---- edits (each one undoable) ----

  function commit(next: Partial<Snapshot>) {
    edit({ history: [...history.slice(-99), { words, speakers }], ...(next.words ? { words: next.words } : {}), ...(next.speakers ? { speakers: next.speakers } : {}) });
  }

  function undo() {
    const last = history.at(-1);
    if (!last) return;
    edit({ history: history.slice(0, -1), words: last.words, speakers: last.speakers });
    setEditing(null);
    setMenu(null);
  }

  function retype(id: string, text: string) {
    setEditing(null);
    const clean = text.trim().replace(/\s+/g, ' ');
    const old = words.find((w) => w.id === id);
    if (!old) return;
    if (clean === old.text) {
      // keeping a doubtful word as it is says it is fine
      if (old.doubt) commit({ words: words.map((w) => (w.id === id ? { ...w, doubt: undefined } : w)) });
      return;
    }
    commit({ words: clean ? words.map((w) => (w.id === id ? { ...w, text: clean, doubt: undefined } : w)) : words.filter((w) => w.id !== id) });
  }

  /** Replace the selected words with typed text (empty deletes them). */
  function retypeSelection(text: string) {
    if (!selected.length) return;
    const next = replaceWords(words, selection, text, () => `w${nextId++}`);
    commit({ words: next, speakers: usedSpeakers(speakers, next) });
    setSelected([]);
  }

  function deleteSelection() {
    if (!selected.length) return;
    const next = deleteWords(words, selection);
    commit({ words: next, speakers: usedSpeakers(speakers, next) });
    setSelected([]);
  }
  deleteRef.current = deleteSelection;

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

  /** Go to the next doubtful word: play from just before it and open it for correcting (Enter keeps it). */
  function checkNext() {
    const doubts = words.filter((w) => w.doubt);
    if (!doubts.length) return;
    const next = doubts[(doubts.findIndex((w) => w.id === lastCheck.current) + 1) % doubts.length];
    lastCheck.current = next.id;
    document.querySelector(`[data-w="${next.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    seek(Math.max(0, next.start - 0.7), true); // checking a word means listening to it
    setEditing(next.id);
  }

  function replaceHere() {
    const m = matches[at];
    if (!m) return;
    const next = replaceMatch(words, m, replacement, () => `w${nextId++}`);
    commit({ words: next, speakers: usedSpeakers(speakers, next) });
  }

  function replaceEverywhere() {
    if (!matches.length) return;
    const next = replaceAll(words, matches, replacement, () => `w${nextId++}`);
    commit({ words: next, speakers: usedSpeakers(speakers, next) });
    setNotice(`Replaced ${matches.length === 1 ? 'one place' : `${matches.length} places`}. Undo puts them all back.`);
  }

  function selectRange(from: string, to: string) {
    const [a, b] = [index.get(from), index.get(to)];
    if (a == null || b == null) return;
    setSelected(words.slice(Math.min(a, b), Math.max(a, b) + 1).map((w) => w.id));
  }

  /** Move the player to `t`. It keeps playing if it was playing; a paused player stays paused (unless `play`). */
  function seek(t: number, play = false) {
    const m = media.current;
    if (!m) return;
    m.currentTime = t;
    if (play || !m.paused) void m.play();
  }

  const name = (title.trim() || 'Transcript').replace(/[\\/:*?"<>|]+/g, '-');
  const subtitle = () =>
    `Transcript of ${file?.name ?? 'a recording'} · ${clock(duration)} · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;

  function exportAs(kind: 'docx' | 'txt' | 'pdf') {
    const opts = { timecodes, rtl, markOverlap: markOverlap && talkedOver, ...(showSpeakers ? { speakerNames: namesOf(speakers) } : {}) };
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

  const where = parts > 1 && part ? `Part ${part} of about ${parts}: ` : '';
  const status =
    where + (phase === 'decoding'
      ? 'Reading the sound'
      : phase === 'model'
        ? included(cfg.model.id)
          ? 'Loading the speech model'
          : `Loading the speech model (${cfg.model.size}, once)`
        : phase === 'transcribing'
          ? `Transcribing on the ${device}`
          : stage === 'download'
            ? IS_APP
              ? 'Loading the speaker models'
              : `Loading the speaker models (${SPEAKER_MODELS}, once)`
            : 'Identifying speakers');

  // the speaker of every selected word, if all the same (ticked in the bar)
  const selectedSpeaker = useMemo(() => {
    const set = new Set(words.filter((w) => selection.has(w.id)).map((w) => w.speaker));
    return set.size === 1 ? ([...set][0] ?? null) : null;
  }, [words, selection]);

  return (
    <div
      className="app"
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        add([...e.dataTransfer.files]);
      }}
    >
      <header className="top">
        <strong className="brand">Transcriber</strong>
        <span className="muted small">Audio and video to text, on this computer</span>
        {viewId != null && (
          <button className="ghost" onClick={() => setViewId(null)}>
            Add files
          </button>
        )}
      </header>

      {docs.length > 0 && (
        <nav className="files" aria-label="Files">
          {docs.map((d) => (
            <button key={d.id} className={`file${d.id === viewId ? ' on' : ''}`} onClick={() => setViewId(d.id)} title={d.phase === 'error' ? d.error : d.file?.name}>
              <span className="nm">{d.file?.name}</span>
              <span className="st">
                {d.phase === 'queued' ? 'waiting' : d.phase === 'error' ? 'failed' : working(d.phase) ? `${Math.round(d.progress * 100)}%` : '✓'}
              </span>
              <span
                className="x"
                role="button"
                aria-label={`Remove ${d.file?.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(d.id);
                }}
              >
                ×
              </span>
            </button>
          ))}
        </nav>
      )}

      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        multiple
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          add(files);
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

      {!cur || (phase === 'error' && !words.length) ? (
        <main className="empty">
          <div className={`drop${over ? ' over' : ''}`}>
            <h1>Drop an audio or video file</h1>
            <p>
              MP3, WAV, M4A, MP4, MOV, WebM and more. Everything stays on this computer: nothing is uploaded.{' '}
              {included(model.id)
                ? 'The speech and speaker models for this choice are inside the app, so it works with the internet off.'
                : IS_APP
                  ? `The first time, this speech model (${model.size}) downloads once and is then kept. The speaker models are inside the app.`
                  : `The first time, the speech model (${model.size}) and the speaker models (${SPEAKER_MODELS}) download once and are then kept.`}
            </p>
            <button className="primary" onClick={() => input.current?.click()}>
              Choose files
            </button>
            {phase === 'error' && (
              <>
                <p className="error">{error}</p>
                <button onClick={() => viewId != null && retry(viewId)}>Try again</button>
              </>
            )}
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
                      {q.label} ({included(modelFor(settings.language, q.id).id) ? 'included' : modelFor(settings.language, q.id).size})
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

          {phase === 'queued' && (
            <div className="progress">
              <div className="row">
                <span>Waiting for the other files…</span>
                <span className="grow" />
                <button onClick={() => viewId != null && remove(viewId)}>Remove</button>
              </div>
            </div>
          )}
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
          {!busy && words.length > 0 && (
            <p className="tip">
              {showSpeakers
                ? 'To change who spoke a whole paragraph, click the speaker name above it. To change just part of one, even half a sentence, select those words (drag over them, or right-click a word) and pick the speaker in the bar that appears.'
                : 'To label who spoke, select words (drag over them, or right-click a word) and pick or add a speaker in the bar that appears. Or use Identify speakers.'}
            </p>
          )}
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
              {talkedOver && (
                <label className="check small" title="Wrap the stretches where people talk over each other in [overlap: ...]">
                  <input type="checkbox" checked={markOverlap} onChange={(e) => setMarkOverlap(e.target.checked)} />
                  Mark talking over
                </label>
              )}
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
              <button onClick={identifyAgain} disabled={!haveAudio || anyWork} title={haveAudio ? undefined : 'The audio is no longer available: only the file worked on last keeps it. Transcribe the file again.'}>
                {speakers.length ? 'Identify again' : 'Identify speakers'}
              </button>
              {cur?.voices && (
                <span className="sep" title={fixedCount ? 'Not used while a number of speakers is chosen' : 'Left if different people were merged, right if one person was split in two'}>
                  <span className="muted">Separate more</span>
                  <input
                    type="range"
                    min={0}
                    max={SEPARATION_LEVELS.length - 1}
                    step={1}
                    value={sepDraft ?? cur.separation}
                    disabled={!!fixedCount}
                    aria-label="Speaker separation"
                    onChange={(e) => setSepDraft(Number(e.target.value))}
                    onPointerUp={commitSeparation}
                    onKeyUp={commitSeparation}
                    onBlur={commitSeparation}
                  />
                  <span className="muted">Merge more</span>
                </span>
              )}
              <span className="grow" />
              <button className="ghost" onClick={undo} disabled={!history.length} title="Undo (Ctrl or Cmd + Z)">
                Undo
              </button>
            </div>
          )}

          {words.length > 0 && (
            <div className="search" role="search">
              <input
                ref={searchBox}
                type="search"
                value={query}
                placeholder="Search the transcript (Ctrl or Cmd + F)"
                aria-label="Search the transcript"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHit(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && matches.length) {
                    e.preventDefault();
                    setHit((at + (e.shiftKey ? -1 : 1) + matches.length) % matches.length);
                  }
                  if (e.key === 'Escape') setQuery('');
                }}
              />
              {query.trim() && <span className="muted small">{matches.length ? `${at + 1} of ${matches.length}` : 'No matches'}</span>}
              <button onClick={() => setHit((at - 1 + matches.length) % matches.length)} disabled={!matches.length} aria-label="Previous match">
                ▲
              </button>
              <button onClick={() => setHit((at + 1) % matches.length)} disabled={!matches.length} aria-label="Next match">
                ▼
              </button>
              <button className="ghost" onClick={() => setReplaceOpen(!replaceOpen)} aria-expanded={replaceOpen}>
                Replace…
              </button>
              {doubtful > 0 && !busy && (
                <button onClick={checkNext} title="Words whose sound or timing looks doubtful: play and correct them one by one">
                  {doubtful} to check
                </button>
              )}
            </div>
          )}
          {words.length > 0 && replaceOpen && (
            <div className="replace">
              <input
                value={replacement}
                placeholder="Replace whole words with (leave empty to delete them)"
                aria-label="Replace with"
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && matches.length && !busy && replaceHere()}
              />
              <button onClick={replaceHere} disabled={!matches.length || busy}>
                Replace
              </button>
              <button onClick={replaceEverywhere} disabled={!matches.length || busy}>
                Replace all{matches.length ? ` (${matches.length})` : ''}
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
              found={found}
              foundNow={foundNow}
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
            <p className="muted small hint">Click a word to play from there. Drag or Shift-click to select words (a phrase, even half a sentence), or right-click one word, then give them to a speaker, retype or delete them. Double-click a single word to correct it.</p>
          )}
          {!busy && selected.length > 0 && <SelectionBar
              count={selected.length}
              speakers={speakers}
              current={selectedSpeaker}
              text={textOf(words, selection)}
              onGive={(to) => give(selection, to)}
              onRetype={retypeSelection}
              onDelete={deleteSelection}
              onSentence={() => setSelected(wholeSentences(words, selection))}
              onTurn={() => setSelected(toEndOfTurn(words, selection))}
              onClear={() => setSelected([])}
            />}
        </main>
      )}
      {over && <div className="drop-cover">Drop to transcribe</div>}
    </div>
  );
}
