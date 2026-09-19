const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (cb) => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('presentation', {
  getState: () => ipcRenderer.invoke('get-presentation-state'),
  onSetLocationText: subscribe('set-location-text'),
  onSetScrollText: subscribe('set-scroll-text'),
  onMapView: subscribe('map-view'),
  onMapMarks: subscribe('map-marks'),
  onMoveMode: subscribe('set-move-mode'),
  onShowMedia: subscribe('show-media'),
  onSetBanner: subscribe('set-banner'),
  onClearBanner: subscribe('clear-banner'),
  onAudioLoad: subscribe('audio-load'),
  onAudioControl: subscribe('audio-control')
});
