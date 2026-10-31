'use strict';
const { contextBridge, ipcRenderer } = require('electron');
let pageMenuOpen = false;
ipcRenderer.on('workspace:page-menu', (_event, open) => { pageMenuOpen = open === true; });
window.addEventListener('pointerdown', event => {
  if (event.isTrusted && pageMenuOpen) ipcRenderer.send('workspace:page-menu-dismiss');
}, true);

// Remote workbenches get only presentation controls, never the desktop management bridge.
contextBridge.exposeInMainWorld('hajiminkWorkspace', Object.freeze({
  ready: () => ipcRenderer.send('workspace:ready'),
  sidebarOpen: value => { if (typeof value === 'boolean') ipcRenderer.send('workspace:sidebar-open', value); },
  showWorkspace: () => ipcRenderer.send('workspace:show'),
  showSettings: () => ipcRenderer.send('workspace:show-settings'),
  setHeader: value => ipcRenderer.send('workspace:header', value),
  onTheme: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('workspace:theme', listener);
    return () => ipcRenderer.removeListener('workspace:theme', listener);
  },
  onSearch: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('workspace:search', listener);
    return () => ipcRenderer.removeListener('workspace:search', listener);
  },
  onHeaderAction: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('workspace:header-action', listener);
    return () => ipcRenderer.removeListener('workspace:header-action', listener);
  },
  onSurface: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('workspace:surface', listener);
    return () => ipcRenderer.removeListener('workspace:surface', listener);
  }
}));
