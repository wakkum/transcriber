// The desktop app: the built site (dist/) in a window, served from its own app:// address, so web
// workers, the model cache and WebCodecs work as in a browser and nothing needs a server or npm.
const { app, BrowserWindow, Menu, dialog, protocol, net, shell, session } = require('electron');
const path = require('node:path');
const csp = require('./csp.cjs');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
// models that ship inside the app (scripts/fetch-models.mjs), served under /models/
const MODELS = path.join(__dirname, '..', 'models');

// A packaged app must not hand its window to other programs: the debugging switches would let any
// local process read or change an open transcript.
if (app.isPackaged && (app.commandLine.hasSwitch('remote-debugging-port') || app.commandLine.hasSwitch('remote-debugging-pipe'))) app.exit(1);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

function serve() {
  protocol.handle('app', (req) => {
    let file, base;
    try {
      const { pathname } = new URL(req.url);
      const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      base = rel.startsWith('/models/') ? MODELS : DIST;
      file = path.normalize(path.join(base, base === MODELS ? rel.slice('/models'.length) : rel));
    } catch {
      return new Response('Bad request', { status: 400 }); // a malformed %-escape
    }
    if (!file.startsWith(base + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString()).then((res) => {
      // the policy as a header too: unlike the page's tag it also applies to the workers
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', csp);
      return new Response(res.body, { status: res.status, headers });
    });
  });
}

function open() {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 420,
    minHeight: 480,
    title: 'Transcriber',
    backgroundColor: '#fbfaf8',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  // links out of the app (none today) open in the real browser, never inside the window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  // The page asks before it is closed while there is a transcript (beforeunload). Electron shows
  // nothing for that by itself and would just refuse to close, so ask here.
  win.webContents.on('will-prevent-unload', (e) => {
    const leave = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      title: 'Transcriber',
      message: 'Leave without exporting?',
      detail: 'The transcript is only kept while this window is open.',
    });
    if (leave === 0) e.preventDefault(); // ignore the page's objection: close
  });
  void win.loadURL('app://transcriber/');
}

app.whenReady().then(() => {
  serve();
  // the page asks for nothing it needs: no camera, microphone, location or notifications
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  open();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) open();
  });
});

app.on('window-all-closed', () => app.quit());
