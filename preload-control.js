const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (cb) => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('dm', {
  getState: () => ipcRenderer.invoke('get-state'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  pickMp3: () => ipcRenderer.invoke('pick-mp3'),
  addAudioEntry: (entry) => ipcRenderer.invoke('add-audio-entry', entry),
  updateAudioEntry: (upd) => ipcRenderer.invoke('update-audio-entry', upd),
  loadBanners: () => ipcRenderer.invoke('load-banners'),
  openBannersFile: () => ipcRenderer.invoke('open-banners-file'),
  removeAudioEntry: (id) => ipcRenderer.invoke('remove-audio-entry', id),

  showMedia: (data) => ipcRenderer.send('show-media', data),
  setScrollText: (text) => ipcRenderer.send('set-scroll-text', text),
  setLocationText: (text) => ipcRenderer.send('set-location-text', text),
  mapView: (view) => ipcRenderer.send('map-view', view),
  mapMarks: (marks) => ipcRenderer.send('map-marks', marks),
  setMoveMode: (on) => ipcRenderer.send('set-move-mode', !!on),
  recenterPresentation: () => ipcRenderer.send('recenter-presentation'),
  setBanner: (text) => ipcRenderer.send('set-banner', text),
  clearBanner: () => ipcRenderer.send('clear-banner'),
  audioLoad: (entry) => ipcRenderer.send('audio-load', { id: entry.id }),
  audioControl: (msg) => ipcRenderer.send('audio-control', msg),

  onMediaList: subscribe('media-list')
});
