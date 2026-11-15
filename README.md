# Transcriber

Audio and video to text, on your own computer. Drop a file, get a transcript with every line timecoded and each speaker named, then export it as Word, PDF or plain text. Nothing is uploaded: the speech and speaker models run locally and download once, the first time.

Built from the transcription part of [Yarnit](https://github.com/wakkum/yarnit).

## Use it

**The app (no npm, no browser address).** Open the file for your system from `release/`:

- **Mac:** `Transcriber-<version>-mac-arm64.dmg` (Apple Silicon: M1 or newer) or `...-mac-x64.dmg` (Intel). Drag Transcriber to Applications. It is not signed by Apple, so the first time: right-click the app, choose Open, then Open again.
- **Windows:** unzip `Transcriber-<version>-win-x64.zip` and double-click `Transcriber.exe`. Windows may show "Windows protected your PC": choose More info, then Run anyway.

The Balanced English speech model (base.en) and the speaker models ship inside the app, so English transcription with speakers works with the internet off from the first launch. Other languages and qualities (speech 40 to 250 MB) download once on first use and are then kept in the app's own storage on that computer.

**From the source** (to change it): `npm install`, then `npm run app` (the desktop window), `npm start` (in a browser) or `npm run dev`. Needs [Node.js](https://nodejs.org) 22.12 or newer; `start.command` (Mac) and `start.bat` (Windows) do the same as `npm start`.

**Build the apps:** `npm run pack:mac` and `npm run pack:win` write to `release/`. Mac builds must be made on a Mac; the Windows zip can be made on either.

## What it does

- **Files:** audio (MP3, WAV, M4A, AAC, FLAC, Ogg, Opus) and video (MP4, MOV, WebM, MKV and more). Only the sound track is decoded, a chunk at a time, so long videos don't fill memory (about 9 seconds per hour of video). Files the stream decoder can't read go through the browser's own decoder.
- **Languages:** English uses the English-only Whisper models; 24 other languages (Arabic, French, Spanish, Turkish, Urdu, ...) use the multilingual ones. Quality: Fastest (tiny), Balanced (base), Most accurate (small). GPU (WebGPU) is optional and experimental.
- **Speakers:** found after transcribing, with a count of 2 to 8 if you know it (more reliable than automatic for similar voices), or not at all. A new paragraph starts whenever the speaker changes.
  - Click a speaker's name to rename them (everywhere, and in the exports), give that paragraph to someone else or a new speaker, or merge them into another speaker.
  - Drag across words, or click one and Shift-click another, then use the bar at the bottom to give those words to a speaker. This splits a paragraph.
  - Wrong count? Pick the number in the Speakers box and choose Identify again (this replaces your edits).
  - Undo with the Undo button or Ctrl/Cmd + Z.
- **Transcript:** paragraphs at pauses and speaker changes, each cut into lines of a sentence or a few seconds, every line timecoded. Click a word or timecode to play from there; the line playing is highlighted. Double-click a word to correct it (empty removes it). Right-to-left languages are laid out right to left.
- **Export:** Word (.docx), PDF and text (.txt), with or without timecodes, under a title you can edit; speaker names are included when there are two or more.
  - PDF is written directly with the PDF's built-in Helvetica, which covers Western European text. For other scripts (Arabic, Cyrillic, Chinese, ...) the print window opens instead: choose "Save as PDF".

The transcript lives only in the open window: export it before closing (the app asks before you leave).

## How speakers are found

Two small models, both on the WASM engine (the segmentation model doesn't support WebGPU): pyannote segmentation 3.0 and a WeSpeaker ResNet34 voice embedding (both via Transformers.js). The speech is cut into windows of up to 10 seconds at pauses; the segmentation model says who talks in each part of a window; each person's own audio in a window gets a voice embedding; clustering joins the same voice across windows; every word takes the speaker talking over it. Checked on synthetic voices (3 voices, 8 turns, all correct) but not yet on real recordings: similar voices, overlapping talk and phone audio are where it will make mistakes, and the fixes above are there for that.

## Code

| Path | What |
| --- | --- |
| `src/App.tsx` | The page: drop zone and settings, progress, player, export bar, edits and undo |
| `src/ui/Transcript.tsx`, `SpeakerMenu.tsx` | Lines and words (click, drag-select, correct), speaker menu, selection bar |
| `src/audio/decode.ts` | File to 16 kHz mono: Mediabunny (WebCodecs) streaming, browser decoder as fallback |
| `src/workers/transcribe.worker.ts`, `diarize.worker.ts` | Whisper and the speaker models via Transformers.js, off the main thread; `ort.ts` points ONNX Runtime at the copy bundled in the app (no CDN) |
| `src/engine/` | Pure TypeScript, tested with Vitest: `resample`, `speech`, `transcript`, `speakers` (names, assign, merge), `diarize` (windows, local speakers, word assignment), `cluster`, `docx` + `zip`, `pdf`, `html`, `models` |
| `electron/main.cjs` | The desktop window: serves `dist/` from its own `app://` address, blocks permissions and outside navigation |

`npm run check` runs the type check, oxlint and the tests.

Dependencies: Transformers.js (Apache-2.0), Mediabunny (MPL-2.0), React (MIT), Electron (MIT). Models: Whisper (MIT), pyannote segmentation 3.0 (MIT), WeSpeaker ResNet34 (CC BY 4.0 per its model page: check before redistributing).

## Security notes

- The app runs sandboxed with a strict Content Security Policy (`electron/csp.cjs`). It serves its own files from a private `app://` address, denies all device permissions and blocks navigation away from itself.
- Packaged apps refuse debugging switches, and the Electron fuses disable running it as a plain Node process.
- Models are fetched by exact Hugging Face commit (`REVISIONS` in `src/engine/models.ts`), not from a branch that can change. Even `config.json` is rewritten to the pinned commit in `src/workers/ort.ts`.
- Stop finishes the piece being transcribed and keeps the words found so far, which can still be exported. Closing the window mid-job asks first.
- The Mac apps are ad-hoc signed, so the first open needs right-click, then Open. Packaged sizes: about 205 MB per Mac disk image, 235 MB for the Windows zip, models included.

## Bundled models

`npm run models` downloads the bundled models by exact commit into `models/` (about 106 MB, not kept in git). `npm run app`, `pack:mac` and `pack:win` run it first. The app serves them from `app://transcriber/models/` and Transformers.js looks there before the network.

## License and credits

The code is MIT licensed (see `LICENSE`). The app bundles and downloads these models, each under its own license:

- Whisper (OpenAI), as ONNX conversions by Xenova: Apache-2.0.
- pyannote segmentation 3.0 (pyannote.audio), ONNX conversion by onnx-community: MIT.
- WeSpeaker ResNet34-LM speaker embeddings (WeSpeaker, trained on VoxCeleb), ONNX conversion by onnx-community: CC-BY-4.0. Credit to the WeSpeaker authors.

Built with Transformers.js, ONNX Runtime Web, Mediabunny, Electron, React and Vite.
