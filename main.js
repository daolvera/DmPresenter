const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const Store = require('electron-store');
const chokidar = require('chokidar');

const store = new Store({
  defaults: {
    mediaFolderPath: null,
    audioLibrary: [],
    presentationBounds: { width: 1920, height: 1080 },
    lastBanner: '',
    scrollText: 'Mythos',
    locationText: ''
  }
});

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a'];

let controlWin = null;
let presentationWin = null;
let watcher = null;
const mediaFiles = new Map(); // path -> {path,name,type,url}
let listTimer = null;
let sweepTimer = null;
let shownPath = null; // file currently on the Presentation window

// Autoplay from IPC commands without a user gesture inside the presentation window.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Keep the Presentation window painting when it is covered by other windows, so Discord's
// capture never freezes while the DM works in another app.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function mediaTypeOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

function parseYouTubeId(input) {
  try {
    const u = new URL(String(input).trim());
    const host = u.hostname.replace(/^www\.|^m\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.split('/')[1];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else {
        const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?]+)/);
        if (m) id = m[1];
      }
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- folder watching ----------
function pushMediaList() {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => {
    const list = [...mediaFiles.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    send(controlWin, 'media-list', list);
  }, 100);
}

function startWatching(folder) {
  if (watcher) watcher.close();
  watcher = null;
  clearInterval(sweepTimer);
  shownPath = null;
  mediaFiles.clear();
  pushMediaList();
  if (!folder) return;

  const onAdd = (file) => {
    const type = mediaTypeOf(file);
    if (!type) return;
    mediaFiles.set(file, { path: file, name: path.basename(file), type, url: pathToFileURL(file).href });
    pushMediaList();
  };
  const onRemove = (file) => {
    if (!mediaFiles.delete(file)) return;
    if (file === shownPath) {
      shownPath = null;
      send(presentationWin, 'show-media', { path: null });
    }
    pushMediaList();
  };

  // Deletes (Explorer, Recycle Bin, other apps) aren't always reported as 'unlink' on Windows,
  // so double-check the files we know about.
  clearInterval(sweepTimer);
  sweepTimer = setInterval(() => {
    for (const file of [...mediaFiles.keys()]) {
      if (!fs.existsSync(file)) onRemove(file);
    }
  }, 1500);

  watcher = chokidar
    .watch(folder, { depth: 0, ignoreInitial: false, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } })
    .on('add', onAdd)
    .on('change', onAdd) // refreshes url so <img> can be re-read
    .on('unlink', onRemove)
    .on('error', (err) => console.error('watcher error:', err));
}

// ---------- windows ----------
function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 1100,
    height: 780,
    title: 'DM Presenter — Control',
    backgroundColor: '#14161c',
    webPreferences: {
      preload: path.join(__dirname, 'preload-control.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  controlWin.setMenuBarVisibility(false);
  controlWin.loadFile('control.html');
  controlWin.on('closed', () => {
    controlWin = null;
    app.quit();
  });
}

function createPresentationWindow() {
  const b = store.get('presentationBounds') || {};
  const opts = { width: b.width || 1920, height: b.height || 1080 };
  if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
    opts.x = b.x;
    opts.y = b.y;
  }
  presentationWin = new BrowserWindow({
    ...opts,
    useContentSize: true,
    frame: false,
    resizable: false,
    title: 'DM Presenter — Presentation',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-presentation.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  presentationWin.loadFile('presentation.html');
  // A minimized window stops being captured; undo any minimize (e.g. Win+D / Win+M).
  presentationWin.on('minimize', () => presentationWin.restore());

  // No title bar, so the DM moves it via the system menu (Alt+Space > Move) or Win+arrows;
  // the resulting position is remembered.
  let saveTimer = null;
  const saveBounds = () => {
    if (!presentationWin || presentationWin.isDestroyed()) return;
    store.set('presentationBounds', presentationWin.getContentBounds());
  };
  const debounced = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 300);
  };
  presentationWin.on('move', debounced);
  presentationWin.on('close', saveBounds);
  presentationWin.on('closed', () => {
    presentationWin = null;
  });
}

// ---------- banner presets ----------
// Packaged apps can't edit files inside the app bundle, so keep an editable copy in the user data folder.
const BANNERS_DEFAULT = path.join(__dirname, 'banners.json');
const BANNERS_FILE = app.isPackaged ? path.join(app.getPath('userData'), 'banners.json') : BANNERS_DEFAULT;
if (app.isPackaged && !fs.existsSync(BANNERS_FILE)) {
  try {
    fs.mkdirSync(path.dirname(BANNERS_FILE), { recursive: true });
    fs.copyFileSync(BANNERS_DEFAULT, BANNERS_FILE);
  } catch (err) {
    console.error('could not create banners.json:', err);
  }
}

function loadBanners() {
  try {
    const list = JSON.parse(fs.readFileSync(BANNERS_FILE, 'utf8'));
    if (!Array.isArray(list)) throw new Error('banners.json must be a JSON array');
    const banners = list
      .filter((b) => b && typeof b.title === 'string')
      .map((b) => ({
        category: String(b.category || 'Other'),
        label: String(b.label || b.title),
        title: b.title,
        text: typeof b.text === 'string' ? b.text : ''
      }));
    return { banners, error: null };
  } catch (err) {
    return { banners: [], error: `Could not read banners.json: ${err.message}` };
  }
}

ipcMain.handle('load-banners', () => loadBanners());
ipcMain.handle('open-banners-file', () => shell.openPath(BANNERS_FILE));

// ---------- IPC: request/response ----------
ipcMain.handle('get-state', () => ({
  mediaFolderPath: store.get('mediaFolderPath'),
  audioLibrary: store.get('audioLibrary'),
  lastBanner: store.get('lastBanner'),
  scrollText: store.get('scrollText'),
  locationText: store.get('locationText'),
  media: [...mediaFiles.values()]
}));

ipcMain.handle('get-presentation-state', () => ({ scrollText: store.get('scrollText'), locationText: store.get('locationText') }));

ipcMain.handle('choose-folder', async () => {
  const res = await dialog.showOpenDialog(controlWin, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return store.get('mediaFolderPath');
  store.set('mediaFolderPath', res.filePaths[0]);
  startWatching(res.filePaths[0]);
  return res.filePaths[0];
});

ipcMain.handle('pick-mp3', async () => {
  const res = await dialog.showOpenDialog(controlWin, {
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXT }]
  });
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
});

ipcMain.handle('add-audio-entry', (_e, entry) => {
  const label = String(entry?.label || '').trim().slice(0, 120);
  let record;
  if (entry?.type === 'youtube') {
    if (!parseYouTubeId(entry.url)) return { ok: false, error: 'That does not look like a YouTube video link.' };
    record = { type: 'youtube', url: String(entry.url).trim(), label: label || 'YouTube track' };
  } else if (entry?.type === 'mp3') {
    if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) return { ok: false, error: 'Invalid file path.' };
    record = { type: 'mp3', path: entry.path, label: label || path.basename(entry.path) };
  } else {
    return { ok: false, error: 'Unknown entry type.' };
  }
  record.id = crypto.randomUUID();
  const library = [...store.get('audioLibrary'), record];
  store.set('audioLibrary', library);
  return { ok: true, library };
});

ipcMain.handle('update-audio-entry', (_e, upd) => {
  const library = store.get('audioLibrary');
  const rec = library.find((x) => x.id === upd?.id);
  if (!rec) return { ok: false, error: 'Entry not found.' };
  const label = String(upd.label || '').trim().slice(0, 120);
  if (rec.type === 'youtube') {
    if (!parseYouTubeId(upd.url)) return { ok: false, error: 'That does not look like a YouTube video link.' };
    rec.url = String(upd.url).trim();
  } else if (upd.path != null) {
    if (typeof upd.path !== 'string' || !path.isAbsolute(upd.path)) return { ok: false, error: 'Invalid file path.' };
    rec.path = upd.path;
  }
  if (label) rec.label = label;
  store.set('audioLibrary', library);
  return { ok: true, library };
});

ipcMain.handle('remove-audio-entry', (_e, id) => {
  const library = store.get('audioLibrary').filter((x) => x.id !== id);
  store.set('audioLibrary', library);
  return library;
});

// ---------- IPC: Control -> Presentation relay ----------
ipcMain.on('show-media', (_e, data) => {
  if (!data || data.path == null) {
    shownPath = null;
    return send(presentationWin, 'show-media', { path: null });
  }
  const folder = store.get('mediaFolderPath');
  const known = mediaFiles.get(data.path);
  // Only forward files the watcher has actually seen inside the chosen folder.
  if (!folder || !known || !isInside(folder, known.path)) return;
  shownPath = known.path;
  send(presentationWin, 'show-media', { path: known.path, type: known.type, url: known.url });
});

ipcMain.on('set-scroll-text', (_e, text) => {
  const t = String(text ?? '').slice(0, 80);
  store.set('scrollText', t);
  send(presentationWin, 'set-scroll-text', t);
});

ipcMain.on('set-location-text', (_e, text) => {
  const t = String(text ?? '').slice(0, 80);
  store.set('locationText', t);
  send(presentationWin, 'set-location-text', t);
});

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : 0));

ipcMain.on('map-view', (_e, v) => {
  send(presentationWin, 'map-view', {
    scale: clamp(Number(v?.scale), 1, 12),
    tx: clamp(Number(v?.tx), -6, 6),
    ty: clamp(Number(v?.ty), -6, 6)
  });
});

ipcMain.on('map-marks', (_e, marks) => {
  if (!Array.isArray(marks)) return;
  // Rebuild from validated numbers/colors only; the renderer's data is not forwarded as-is.
  const clean = marks.slice(0, 500).map((s) => ({
    c: /^#[0-9a-f]{6}$/i.test(s?.c) ? s.c : '#ff3b30',
    w: clamp(Number(s?.w), 1, 60),
    pts: (Array.isArray(s?.pts) ? s.pts : []).slice(0, 5000)
      .map((p) => [clamp(Number(p?.[0]), 0, 1), clamp(Number(p?.[1]), 0, 1)])
  })).filter((s) => s.pts.length > 0);
  send(presentationWin, 'map-marks', clean);
});

ipcMain.on('set-move-mode', (_e, on) => send(presentationWin, 'set-move-mode', !!on));

ipcMain.on('recenter-presentation', () => {
  if (presentationWin && !presentationWin.isDestroyed()) presentationWin.center();
});

ipcMain.on('set-banner', (_e, banner) => {
  // Accepts a plain string (typed banner) or {title, text} (preset).
  const isText = typeof banner === 'string';
  const title = String(isText ? banner : banner?.title ?? '').slice(0, 300);
  const text = isText ? '' : String(banner?.text ?? '').slice(0, 600);
  if (!title) return;
  if (isText) store.set('lastBanner', title);
  send(presentationWin, 'set-banner', { title, text });
});

ipcMain.on('clear-banner', () => send(presentationWin, 'clear-banner'));

ipcMain.on('audio-load', (_e, entry) => {
  // Resolve from the persisted library so the renderer can't inject arbitrary paths/URLs.
  const rec = store.get('audioLibrary').find((x) => x.id === entry?.id);
  if (!rec) return;
  if (rec.type === 'youtube') {
    send(presentationWin, 'audio-load', { type: 'youtube', label: rec.label, videoId: parseYouTubeId(rec.url) });
  } else {
    send(presentationWin, 'audio-load', { type: 'mp3', label: rec.label, url: pathToFileURL(rec.path).href });
  }
});

ipcMain.on('audio-control', (_e, msg) => {
  const action = msg?.action;
  if (!['play', 'pause', 'stop', 'volume'].includes(action)) return;
  const value = action === 'volume' ? Math.min(100, Math.max(0, Number(msg.value) || 0)) : undefined;
  send(presentationWin, 'audio-control', { action, value });
});

// ---------- app lifecycle ----------
app.whenReady().then(() => {
  // YouTube's player rejects embeds with no Referer (error 153), which is what a file:// page sends.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.youtube.com/*', '*://*.ytimg.com/*', '*://*.youtube-nocookie.com/*'] },
    (details, cb) => {
      details.requestHeaders['Referer'] = 'https://dm-presenter.local/';
      cb({ requestHeaders: details.requestHeaders });
    }
  );

  createControlWindow();
  createPresentationWindow();
  startWatching(store.get('mediaFolderPath'));
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => watcher && watcher.close());
