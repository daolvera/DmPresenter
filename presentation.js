const api = window.presentation;
const $ = (id) => document.getElementById(id);

const img = $('media-img');
const video = $('media-video');
const banner = $('banner');
const mp3 = $('mp3');

// ---------- title plaques (top: title, bottom: location) ----------
function makePlaque(boxId, labelId) {
  const box = $(boxId);
  const label = $(labelId);
  // Shrink the font until the label fits on one line inside the plaque.
  const fit = () => {
    let size = 40;
    label.style.fontSize = size + 'px';
    while (size > 12 && label.scrollWidth > box.clientWidth - 54) {
      size -= 1;
      label.style.fontSize = size + 'px';
    }
  };
  window.addEventListener('resize', () => { if (!box.hidden) fit(); });
  return (text) => {
    label.textContent = text || '';
    box.hidden = !text;
    if (text) fit();
  };
}
const setScrollText = makePlaque('scroll-text', 'scroll-label');
const setLocationText = makePlaque('location-text', 'location-label');
api.onSetScrollText(setScrollText);
api.onSetLocationText(setLocationText);
api.getState().then((st) => {
  setScrollText(st.scrollText);
  setLocationText(st.locationText);
});

// ---------- move mode ----------
api.onMoveMode((on) => { $('move-overlay').hidden = !on; });

// ---------- media ----------
function clearMedia() {
  img.hidden = true;
  img.removeAttribute('src');
  video.hidden = true;
  video.pause();
  video.removeAttribute('src');
  video.load();
}

const world = $('world');
const marksSvg = $('marks');
const IDENTITY = { scale: 1, tx: 0, ty: 0 };
function resetMap() {
  MapView.applyView(world, IDENTITY);
  MapView.renderMarks(marksSvg, []);
}
api.onMapView((v) => MapView.applyView(world, v));
api.onMapMarks((marks) => MapView.renderMarks(marksSvg, marks));

api.onShowMedia((data) => {
  clearMedia();
  resetMap(); // Control re-sends the saved view and marks for this file right after
  document.body.classList.toggle('has-media', !!(data && data.path));
  if (!data || !data.path) return;
  if (data.type === 'video') {
    video.src = data.url;
    video.hidden = false;
    video.play().catch(() => {});
  } else {
    img.src = data.url;
    img.hidden = false;
  }
});

// ---------- banner ----------
api.onSetBanner(({ title, text }) => {
  $('banner-title').textContent = title;
  $('banner-text').textContent = text || '';
  banner.hidden = !title;
});
api.onClearBanner(() => {
  banner.hidden = true;
  $('banner-title').textContent = '';
  $('banner-text').textContent = '';
});

// ---------- audio ----------
let volume = 80; // 0-100
let activeType = null; // 'youtube' | 'mp3' | null
let ytPlayer = null;
let ytReady = false;
let pendingVideoId = null;

mp3.volume = volume / 100;

function silenceMp3() {
  mp3.pause();
  mp3.removeAttribute('src');
  mp3.load();
}

function silenceYouTube() {
  pendingVideoId = null;
  if (ytReady) ytPlayer.stopVideo();
}

function createYouTubePlayer() {
  ytPlayer = new YT.Player('yt-player', {
    width: 200,
    height: 200,
    playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1 },
    events: {
      onReady: () => {
        ytReady = true;
        ytPlayer.setVolume(volume);
        if (pendingVideoId) {
          ytPlayer.loadVideoById(pendingVideoId);
          pendingVideoId = null;
        }
      }
    }
  });
}

// Called by the YouTube IFrame API script once it has loaded.
window.onYouTubeIframeAPIReady = createYouTubePlayer;

function ensureYouTubeApi() {
  if (ytPlayer || document.getElementById('yt-api')) return;
  const s = document.createElement('script');
  s.id = 'yt-api';
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
}

api.onAudioLoad((entry) => {
  if (entry.type === 'youtube') {
    silenceMp3();
    activeType = 'youtube';
    if (ytReady) {
      ytPlayer.setVolume(volume);
      ytPlayer.loadVideoById(entry.videoId);
    } else {
      pendingVideoId = entry.videoId;
      ensureYouTubeApi();
    }
  } else {
    silenceYouTube();
    activeType = 'mp3';
    mp3.src = entry.url;
    mp3.volume = volume / 100;
    mp3.play().catch((err) => console.error('mp3 play failed:', err));
  }
});

api.onAudioControl(({ action, value }) => {
  if (action === 'volume') {
    volume = value;
    mp3.volume = volume / 100;
    if (ytReady) ytPlayer.setVolume(volume);
    return;
  }
  if (activeType === 'mp3') {
    if (action === 'play') mp3.play().catch(() => {});
    else if (action === 'pause') mp3.pause();
    else if (action === 'stop') { mp3.pause(); mp3.currentTime = 0; }
  } else if (activeType === 'youtube' && ytReady) {
    if (action === 'play') ytPlayer.playVideo();
    else if (action === 'pause') ytPlayer.pauseVideo();
    else if (action === 'stop') ytPlayer.stopVideo();
  }
});
