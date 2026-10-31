'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hajiminkPageMenu', Object.freeze({
  data: () => ipcRenderer.invoke('page-menu:data'),
  choose: value => ipcRenderer.send('page-menu:choose', value),
  close: focus => ipcRenderer.send('page-menu:close', focus)
}));
