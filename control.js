const api = window.dm;
const $ = (id) => document.getElementById(id);

let library = [];
let activeId = null;
let selectedPath = null;
let pendingMp3Path = null; // set while the add form is in MP3 mode
let addMode = null; // 'youtube' | 'mp3' | null
let editingId = null; // id of the entry being edited, or null when adding
let presets = [];

// ---------- live view: pan / zoom / marks ----------
const stageEl = $('live-stage');
const worldEl = $('live-world');
const marksEl = $('live-marks');
const mapStates = new Map(); // path -> {view, marks}; kept for the session so switching maps keeps your marks
let current = null; // {path, type, url}
let tool = 'pan';
let penColor = '#ff3b30';
let flushQueued = false;
let dirtyView = false;
let dirtyMarks = false;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const cur = () => (current ? mapStates.get(current.path) : null);

function clampView(v) {
  v.scale = clamp(v.scale, 1, 12);
  const lim = (v.scale - 1) / 2; // keeps the map covering the stage
  v.tx = clamp(v.tx, -lim, lim);
  v.ty = clamp(v.ty, -lim, lim);
}

function paintLive() {
  const st = cur();
  MapView.applyView(worldEl, st ? st.view : { scale: 1, tx: 0, ty: 0 });
  MapView.renderMarks(marksEl, st ? st.marks : []);
}

// Coalesce updates to one IPC message per frame while dragging/drawing.
function queueSend({ view, marks }) {
  dirtyView = dirtyView || !!view;
  dirtyMarks = dirtyMarks || !!marks;
  paintLive();
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(() => {
    flushQueued = false;
    const st = cur();
    if (!st) return;
    if (dirtyView) api.mapView(st.view);
    if (dirtyMarks) api.mapMarks(st.marks);
    dirtyView = dirtyMarks = false;
  });
}

function showLive(item) {
  current = item;
  const img = $('live-img');
  const vid = $('live-video');
  img.hidden = vid.hidden = true;
  vid.removeAttribute('src');
  $('live-empty').hidden = !!item;
  if (item) {
    if (!mapStates.has(item.path)) mapStates.set(item.path, { view: { scale: 1, tx: 0, ty: 0 }, marks: [] });
    if (item.type === 'video') {
      vid.src = item.url;
      vid.hidden = false;
    } else {
      img.src = item.url;
      img.hidden = false;
    }
    api.showMedia({ path: item.path, type: item.type });
    api.mapView(cur().view);
    api.mapMarks(cur().marks);
  } else {
    api.showMedia({ path: null });
  }
  paintLive();
}

function stagePoint(e) {
  const r = stageEl.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width - 0.5, y: (e.clientY - r.top) / r.height - 0.5 }; // relative to center
}

function zoomAt(m, factor) {
  const st = cur();
  if (!st) return;
  const v = st.view;
  const s2 = clamp(v.scale * factor, 1, 12);
  const k = s2 / v.scale;
  v.tx = m.x - k * (m.x - v.tx);
  v.ty = m.y - k * (m.y - v.ty);
  v.scale = s2;
  clampView(v);
  queueSend({ view: true });
}

// screen (center-relative) -> map coordinates (0..1 of the un-zoomed stage)
function toMap(m, v) {
  return [clamp(0.5 + (m.x - v.tx) / v.scale, 0, 1), clamp(0.5 + (m.y - v.ty) / v.scale, 0, 1)];
}

function eraseAt(pt, st) {
  const r = 0.025 / st.view.scale;
  const before = st.marks.length;
  st.marks = st.marks.filter((s) => !s.pts.some((p) => Math.hypot(p[0] - pt[0], (p[1] - pt[1]) * 0.5625) < r));
  if (st.marks.length !== before) queueSend({ marks: true });
}

let drag = null; // {kind:'pan'|'pen'|'erase', last, stroke}
stageEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(stagePoint(e), Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

stageEl.addEventListener('pointerdown', (e) => {
  const st = cur();
  if (!st) return;
  const m = stagePoint(e);
  const kind = e.button === 1 || e.button === 2 ? 'pan' : tool; // middle/right button always pans
  stageEl.setPointerCapture(e.pointerId);
  if (kind === 'pen') {
    const stroke = { c: penColor, w: Number($('pen-size').value), pts: [toMap(m, st.view)] };
    st.marks.push(stroke);
    drag = { kind, stroke };
    queueSend({ marks: true });
  } else if (kind === 'erase') {
    drag = { kind };
    eraseAt(toMap(m, st.view), st);
  } else {
    drag = { kind: 'pan', last: m };
    stageEl.classList.add('dragging');
  }
  e.preventDefault();
});

stageEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const st = cur();
  if (!st) return;
  const m = stagePoint(e);
  if (drag.kind === 'pan') {
    st.view.tx += m.x - drag.last.x;
    st.view.ty += m.y - drag.last.y;
    drag.last = m;
    clampView(st.view);
    queueSend({ view: true });
  } else if (drag.kind === 'pen') {
    const pt = toMap(m, st.view);
    const last = drag.stroke.pts[drag.stroke.pts.length - 1];
    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 0.002) {
      drag.stroke.pts.push(pt);
      queueSend({ marks: true });
    }
  } else {
    eraseAt(toMap(m, st.view), st);
  }
});

const endDrag = () => {
  drag = null;
  stageEl.classList.remove('dragging');
};
stageEl.addEventListener('pointerup', endDrag);
stageEl.addEventListener('pointercancel', endDrag);
stageEl.addEventListener('contextmenu', (e) => e.preventDefault());

function setTool(t) {
  tool = t;
  stageEl.classList.remove('pan', 'pen', 'erase');
  stageEl.classList.add(t);
  for (const b of $('tools').children) b.classList.toggle('on', b.dataset.tool === t);
}
$('tools').addEventListener('click', (e) => {
  if (e.target.dataset.tool) setTool(e.target.dataset.tool);
});
$('swatches').addEventListener('click', (e) => {
  const c = e.target.dataset.color;
  if (!c) return;
  penColor = c;
  for (const b of $('swatches').children) b.classList.toggle('on', b === e.target);
  setTool('pen');
});
$('zoom-in').addEventListener('click', () => zoomAt({ x: 0, y: 0 }, 1.3));
$('zoom-out').addEventListener('click', () => zoomAt({ x: 0, y: 0 }, 1 / 1.3));
$('reset-view').addEventListener('click', () => {
  const st = cur();
  if (!st) return;
  st.view = { scale: 1, tx: 0, ty: 0 };
  queueSend({ view: true });
});
$('undo-mark').addEventListener('click', () => {
  const st = cur();
  if (!st) return;
  st.marks.pop();
  queueSend({ marks: true });
});
$('clear-marks').addEventListener('click', () => {
  const st = cur();
  if (!st) return;
  st.marks = [];
  queueSend({ marks: true });
});
setTool('pan');
paintLive();

// ---------- media ----------
function renderMedia(list) {
  const grid = $('media-grid');
  grid.replaceChildren();
  $('media-empty').hidden = list.length > 0;
  if (current && !list.some((i) => i.path === current.path)) {
    mapStates.delete(current.path);
    selectedPath = null;
    showLive(null);
  }

  for (const item of list) {
    const tile = document.createElement('div');
    tile.className = 'tile' + (item.path === selectedPath ? ' selected' : '');
    tile.title = item.name;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (item.type === 'image') {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = item.url;
      thumb.appendChild(img);
    } else {
      // Let the browser paint the first frame; no thumbnail extraction needed.
      const vid = document.createElement('video');
      vid.muted = true;
      vid.preload = 'metadata';
      vid.src = item.url + '#t=0.5';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '🎞';
      thumb.append(vid, badge);
    }

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.name;

    tile.append(thumb, name);
    tile.addEventListener('click', () => {
      selectedPath = item.path;
      showLive(item);
      for (const t of grid.children) t.classList.toggle('selected', t === tile);
    });
    grid.appendChild(tile);
  }
}

function setFolder(p) {
  $('folder-path').textContent = p || 'No folder chosen';
}

$('choose-folder').addEventListener('click', async () => setFolder(await api.chooseFolder()));
$('clear-media').addEventListener('click', () => {
  selectedPath = null;
  for (const t of $('media-grid').children) t.classList.remove('selected');
  showLive(null);
});

// ---------- scroll title (saved by main on every change) ----------
let scrollTimer = null;
$('scroll-text').addEventListener('input', (e) => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => api.setScrollText(e.target.value), 200);
});

let locationTimer = null;
$('location-text').addEventListener('input', (e) => {
  clearTimeout(locationTimer);
  locationTimer = setTimeout(() => api.setLocationText(e.target.value), 200);
});

// ---------- presentation window position ----------
$('move-mode').addEventListener('change', (e) => api.setMoveMode(e.target.checked));
$('recenter').addEventListener('click', () => api.recenterPresentation());

// ---------- banner ----------
$('show-banner').addEventListener('click', () => {
  const text = $('banner-text').value.trim();
  if (text) api.setBanner(text);
});
$('banner-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('show-banner').click();
});
$('clear-banner').addEventListener('click', () => api.clearBanner());

// ---------- banner presets ----------
function renderPresets() {
  const box = $('preset-list');
  box.replaceChildren();
  const q = $('preset-filter').value.trim().toLowerCase();
  const groups = new Map();
  for (const p of presets) {
    if (q && !(p.label + ' ' + p.title + ' ' + p.text).toLowerCase().includes(q)) continue;
    if (!groups.has(p.category)) groups.set(p.category, []);
    groups.get(p.category).push(p);
  }
  for (const [cat, items] of groups) {
    const h = document.createElement('div');
    h.className = 'preset-cat';
    h.textContent = cat;
    const chips = document.createElement('div');
    chips.className = 'preset-chips';
    for (const p of items) {
      const b = document.createElement('button');
      b.textContent = p.label;
      b.title = p.text || p.title;
      b.addEventListener('click', () => api.setBanner({ title: p.title, text: p.text }));
      chips.appendChild(b);
    }
    box.append(h, chips);
  }
}

async function loadPresets() {
  const res = await api.loadBanners();
  presets = res.banners;
  $('preset-error').textContent = res.error || '';
  renderPresets();
}

$('preset-filter').addEventListener('input', renderPresets);
$('reload-presets').addEventListener('click', loadPresets);
$('edit-presets').addEventListener('click', () => api.openBannersFile());

// ---------- audio library ----------
function renderLibrary() {
  const ul = $('audio-list');
  ul.replaceChildren();
  for (const entry of library) {
    const li = document.createElement('li');
    if (entry.id === activeId) li.className = 'active';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = entry.label;
    label.title = entry.type === 'youtube' ? entry.url : entry.path;

    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = entry.type === 'youtube' ? 'YT' : 'MP3';

    const play = document.createElement('button');
    play.textContent = 'Play';
    play.addEventListener('click', () => {
      activeId = entry.id;
      api.audioLoad(entry);
      renderLibrary();
    });

    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openAddForm(entry.type, entry.path, entry));

    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (entry.id === activeId) {
        api.audioControl({ action: 'stop' });
        activeId = null;
      }
      library = await api.removeAudioEntry(entry.id);
      renderLibrary();
    });

    li.append(label, kind, play, edit, remove);
    ul.appendChild(li);
  }
}

function openAddForm(mode, filePath, entry) {
  addMode = mode;
  editingId = entry ? entry.id : null;
  pendingMp3Path = filePath || null;
  $('add-submit').textContent = entry ? 'Save' : 'Add';
  $('add-change-file').hidden = !(entry && mode === 'mp3');
  $('add-form').hidden = false;
  $('add-url').hidden = mode !== 'youtube';
  $('add-file').hidden = mode !== 'mp3';
  $('add-file').textContent = filePath || '';
  $('add-url').value = entry && mode === 'youtube' ? entry.url : '';
  $('add-label').value = entry
    ? entry.label
    : filePath ? filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') : '';
  $('add-error').textContent = '';
  (mode === 'youtube' ? $('add-url') : $('add-label')).focus();
}

function closeAddForm() {
  addMode = null;
  editingId = null;
  pendingMp3Path = null;
  $('add-form').hidden = true;
}

$('add-youtube').addEventListener('click', () => openAddForm('youtube'));
$('add-mp3').addEventListener('click', async () => {
  const file = await api.pickMp3();
  if (file) openAddForm('mp3', file);
});
$('add-cancel').addEventListener('click', closeAddForm);
$('add-change-file').addEventListener('click', async () => {
  const file = await api.pickMp3();
  if (file) {
    pendingMp3Path = file;
    $('add-file').textContent = file;
  }
});

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = $('add-label').value.trim();
  const entry = addMode === 'youtube'
    ? { type: 'youtube', url: $('add-url').value.trim(), label }
    : { type: 'mp3', path: pendingMp3Path, label };
  const res = editingId
    ? await api.updateAudioEntry({ ...entry, id: editingId })
    : await api.addAudioEntry(entry);
  if (!res.ok) {
    $('add-error').textContent = res.error;
    return;
  }
  library = res.library;
  closeAddForm();
  renderLibrary();
});

// ---------- global audio controls ----------
$('audio-play').addEventListener('click', () => api.audioControl({ action: 'play' }));
$('audio-pause').addEventListener('click', () => api.audioControl({ action: 'pause' }));
$('audio-stop').addEventListener('click', () => api.audioControl({ action: 'stop' }));
$('audio-loop').addEventListener('change', (e) => api.audioControl({ action: 'loop', value: e.target.checked }));
$('volume').addEventListener('input', (e) => {
  $('volume-value').textContent = e.target.value;
  api.audioControl({ action: 'volume', value: Number(e.target.value) });
});

// ---------- startup ----------
api.onMediaList(renderMedia);

(async () => {
  const state = await api.getState();
  setFolder(state.mediaFolderPath);
  $('banner-text').value = state.lastBanner || '';
  $('scroll-text').value = state.scrollText || '';
  $('location-text').value = state.locationText || '';
  library = state.audioLibrary;
  renderLibrary();
  renderMedia(state.media);
  loadPresets();
})();
