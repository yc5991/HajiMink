'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hajimink', Object.freeze({
  state: () => ipcRenderer.invoke('shell:state'),
  quit: () => ipcRenderer.invoke('shell:quit'),
  onExitState: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('shell:exit-state', listener);
    return () => ipcRenderer.removeListener('shell:exit-state', listener);
  },
  probe: value => ipcRenderer.invoke('shell:probe', value),
  gatewayPublicProbe: value => ipcRenderer.invoke('shell:gateway-public-probe', value),
  gatewayProbeDraft: value => ipcRenderer.invoke('shell:gateway-probe-draft', value),
  providerGuide: provider => ipcRenderer.invoke('shell:provider-guide', provider),
  gatewayProvider: provider => ipcRenderer.invoke('shell:gateway-provider', provider),
  gatewayDisableRemote: () => ipcRenderer.invoke('shell:gateway-disable-remote'),
  natappSelect: kind => ipcRenderer.invoke('shell:natapp-select', kind),
  natappSave: () => ipcRenderer.invoke('shell:natapp-save'),
  natappAction: action => ipcRenderer.invoke('shell:natapp-action', action),
  add: value => ipcRenderer.invoke('shell:add', value),
  edit: (id, value) => ipcRenderer.invoke('shell:edit', id, value),
  remove: id => ipcRenderer.invoke('shell:remove', id),
  select: id => ipcRenderer.invoke('shell:select', id),
  page: value => ipcRenderer.invoke('shell:page', value),
  setTheme: value => ipcRenderer.invoke('shell:theme', value),
  onTheme: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('shell:theme', listener);
    return () => ipcRenderer.removeListener('shell:theme', listener);
  },
  openPageMenu: bounds => ipcRenderer.invoke('shell:page-menu-open', bounds),
  dismissPageMenu: () => ipcRenderer.send('shell:page-menu-dismiss'),
  onPageMenu: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('shell:page-menu', listener);
    return () => ipcRenderer.removeListener('shell:page-menu', listener);
  },
  onSelectConnection: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('shell:select-connection', listener);
    return () => ipcRenderer.removeListener('shell:select-connection', listener);
  },
  onWorkspaceHeader: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('shell:workspace-header', listener);
    return () => ipcRenderer.removeListener('shell:workspace-header', listener);
  },
  workspaceHeaderAction: value => ipcRenderer.send('shell:workspace-header-action', value),
  workspaceSearch: () => ipcRenderer.send('shell:workspace-search'),
  layout: bounds => ipcRenderer.send('shell:layout', bounds),
  sidebarOpen: value => ipcRenderer.send('shell:sidebar-open', value),
  modalVisible: value => ipcRenderer.send('shell:modal-visible', value),
  onSidebar: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('shell:sidebar-state', listener);
    return () => ipcRenderer.removeListener('shell:sidebar-state', listener);
  },
  onShowWorkspace: callback => {
    const listener = () => callback();
    ipcRenderer.on('shell:show-workspace', listener);
    return () => ipcRenderer.removeListener('shell:show-workspace', listener);
  },
  onShowSettings: callback => {
    const listener = () => callback();
    ipcRenderer.on('shell:show-settings', listener);
    return () => ipcRenderer.removeListener('shell:show-settings', listener);
  },
  reload: () => ipcRenderer.invoke('shell:reload'),
  authorize: () => ipcRenderer.invoke('shell:authorize'),
  cancelAuthorization: () => ipcRenderer.invoke('shell:authorize-cancel'),
  onAuthorization: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('shell:authorization', listener);
    return () => ipcRenderer.removeListener('shell:authorization', listener);
  },
  gatewayStart: () => ipcRenderer.invoke('shell:gateway-start'),
  gatewayStop: () => ipcRenderer.invoke('shell:gateway-stop'),
  gatewayRestart: () => ipcRenderer.invoke('shell:gateway-restart'),
  gatewaySetPort: port => ipcRenderer.invoke('shell:gateway-port', port),
  gatewayAccount: () => ipcRenderer.invoke('shell:gateway-account'),
  gatewayEnableOwner: origin => ipcRenderer.invoke('shell:gateway-enable-owner', origin),
  gatewayPasskeySetup: origin => ipcRenderer.invoke('shell:gateway-passkey-setup', origin),
  gatewayPrepareAddress: () => ipcRenderer.invoke('shell:gateway-prepare-address'),
  gatewayBindPendingAddress: origin => ipcRenderer.invoke('shell:gateway-bind-pending-address', origin),
  gatewayOpenSetup: value => ipcRenderer.invoke('shell:gateway-open-setup', value),
  gatewayLogs: () => ipcRenderer.invoke('shell:gateway-logs'),
  completeSetup: () => ipcRenderer.invoke('shell:setup-complete'),
  onGateway: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('shell:gateway', listener);
    return () => ipcRenderer.removeListener('shell:gateway', listener);
  },
  onTunnel: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('shell:tunnel', listener);
    return () => ipcRenderer.removeListener('shell:tunnel', listener);
  },
  onStatus: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('shell:status', listener);
    return () => ipcRenderer.removeListener('shell:status', listener);
  }
}));
