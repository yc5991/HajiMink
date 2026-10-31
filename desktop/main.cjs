'use strict';
const { app, BrowserWindow, WebContentsView, Tray, Menu, nativeImage, nativeTheme, protocol, session, ipcMain, dialog, shell, safeStorage, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ConnectionStore, normalizeAddress, allowedViewRequest, providerGuide } = require('./connections.cjs');
const { probeConnection, probePublicGateway, probePublicStream, completePublicDiagnostic, publicProbeTarget } = require('./connection-probe.cjs');
const { ControllerGatewayManager, PENDING_PUBLIC_ORIGIN } = require('./controller-manager.cjs');
const { ExitCoordinator, buildTrayTemplate } = require('./exit-coordinator.cjs');
const { readBootstrap } = require('./gateway-manager.cjs');
const { createSetupBinding, sameSetupGateway, setupNavigationUrl } = require('./setup-navigation.cjs');
const { readNatappSettings } = require('./natapp-manager.cjs');
const { ExternalTunnelStatus } = require('./tunnel-status.cjs');
const { DeviceCredentials } = require('./device-credentials.cjs');
const { DeviceFlow } = require('./device-flow.cjs');
const { eligibleAccounts } = require('./webauthn-selection.cjs');
const configuredSessions = new WeakSet();

app.setName('HajiMink');
const dataDirectoryArgument = process.argv.find(arg => arg.startsWith('--hajimink-data-dir='));
const gatewayPortArgument = process.argv.find(arg => arg.startsWith('--hajimink-gateway-port='));
const configuredGatewayPort = Number(gatewayPortArgument?.slice('--hajimink-gateway-port='.length) || process.env.HAJIMINK_GATEWAY_PORT || 3000);
if (dataDirectoryArgument) app.setPath('userData', path.resolve(dataDirectoryArgument.slice('--hajimink-data-dir='.length)));
protocol.registerSchemesAsPrivileged([{ scheme: 'hajimink', privileges: { standard: true, secure: true } }]);
const shellUrl = 'hajimink://app/index.html';
const pageMenuUrl = 'hajimink://app/page-menu.html';
const desktopPages = ['workspace', 'settings'];
let window, tray, store, gatewayManager, tunnelStatus, credentials, deviceFlow, exitCoordinator, view, selectedId, selectedOrigin, page = 'workspace', quitting = false, viewBounds;
let pageMenu, pageMenuAnchor, pageMenuFocus, pageMenuKind, triggerDismissedAt = 0;
let authorizationStatus = { state: 'idle', message: '', connectionId: null };
let authorizationVisible = false;
let sidebarAvailable = false, sidebarOpen = true, shellModalVisible = false;
let workspaceHeader = null;
let credentialCommit = Promise.resolve();
let viewStatus = { state: 'idle', message: '请选择连接' };
let workspaceLoadFailed = false;
let setupNavigationBinding = null;
let natappSaved = null, natappDraft = { binaryPath: '', configPath: '' }, natappSettingsError = '';

function themeSnapshot() {
  return { theme: store?.snapshot().theme || 'system', dark: nativeTheme.shouldUseDarkColors };
}
function syncTheme() {
  closePageMenu();
  const value = themeSnapshot();
  const backgroundColor = value.dark ? '#1b1b1a' : '#f7f7f5';
  if (window && !window.isDestroyed()) {
    window.setBackgroundColor(backgroundColor);
    if (process.platform === 'win32') window.setTitleBarOverlay({ color: backgroundColor, symbolColor: value.dark ? '#efefeb' : '#20201e', height: 40 });
    window.webContents.send('shell:theme', value);
  }
  if (view && !view.webContents.isDestroyed()) view.webContents.send('workspace:theme', value);
}
function notifyStatus(state, message) {
  viewStatus = { state, message };
  if (window && !window.isDestroyed()) window.webContents.send('shell:status', viewStatus);
}
function shellGateway(value) {
  return value ? { ...value, awaitingPublicOrigin: value.mode === 'owner' && value.publicOrigin === PENDING_PUBLIC_ORIGIN } : value;
}
function notifyTunnel(value) {
  if (window && !window.isDestroyed()) window.webContents.send('shell:tunnel', value);
}
function notifyGateway(value) {
  if (setupNavigationBinding && !sameSetupGateway(setupNavigationBinding, shellGateway(value))) setupNavigationBinding = null;
  tunnelStatus?.setContext(store.snapshot().setup.tunnelProvider, shellGateway(value));
  if (window && !window.isDestroyed()) {
    window.webContents.send('shell:gateway', shellGateway(value));
    if (connection()?.local && value.state !== 'ready' && view) { destroyView(); notifyStatus('error', value.message); }
  }
}
function validSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== shellUrl) throw new Error('不允许此操作');
}
function validPageMenuSender(event) {
  if (!pageMenu || event.sender !== pageMenu.webContents || event.senderFrame !== pageMenu.webContents.mainFrame) return false;
  try { const url = new URL(event.senderFrame.url); return url.protocol === 'hajimink:' && url.hostname === 'app' && url.pathname === '/page-menu.html'; }
  catch { return false; }
}
function closePageMenu(focus = '') {
  if (!pageMenu || pageMenu.isDestroyed()) return;
  pageMenuFocus = focus;
  pageMenu.destroy();
}
function notifyPageMenu(open, focus = '', kind = pageMenuKind) {
  if (window && !window.isDestroyed()) window.webContents.send('shell:page-menu', { open, focus, kind });
  if (view && !view.webContents.isDestroyed()) view.webContents.send('workspace:page-menu', open);
}
async function openPageMenu(bounds) {
  const kind = bounds?.kind;
  if (kind !== 'connection' || !bounds || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 50000) || typeof bounds.dark !== 'boolean' || typeof bounds.keyboard !== 'boolean') throw new Error('菜单位置无效');
  if (pageMenu && !pageMenu.isDestroyed()) { closePageMenu('trigger'); return; }
  if (Date.now() - triggerDismissedAt < 300) return;
  const count = store.snapshot().connections.length;
  if (!count) return;
  const content = window.getContentBounds();
  if (bounds.x + bounds.width > content.width || bounds.y + bounds.height > content.height || !bounds.width || !bounds.height) throw new Error('菜单位置无效');
  pageMenuAnchor = { x: content.x + bounds.x, y: content.y + bounds.y, width: bounds.width, height: bounds.height };
  const workArea = screen.getDisplayMatching(pageMenuAnchor).workArea;
  const width = Math.min(256, workArea.width), height = Math.min(60 + count * 40, 380, workArea.height);
  const x = Math.max(workArea.x, Math.min(pageMenuAnchor.x - 8, workArea.x + workArea.width - width));
  const y = Math.max(workArea.y, Math.min(pageMenuAnchor.y + pageMenuAnchor.height - 4, workArea.y + workArea.height - height));
  const popup = new BrowserWindow({ parent: window, x, y, width, height, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, show: false, skipTaskbar: true, backgroundColor: '#00000000', webPreferences: { preload: path.join(__dirname, 'page-menu-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  pageMenu = popup; pageMenuFocus = ''; pageMenuKind = kind;
  popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popup.webContents.on('will-navigate', event => event.preventDefault());
  popup.on('blur', () => {
    const cursor = screen.getCursorScreenPoint(), anchor = pageMenuAnchor;
    if (anchor && cursor.x >= anchor.x && cursor.x < anchor.x + anchor.width && cursor.y >= anchor.y && cursor.y < anchor.y + anchor.height) triggerDismissedAt = Date.now();
    closePageMenu();
  });
  popup.on('closed', () => {
    if (pageMenu !== popup) return;
    pageMenu = undefined; pageMenuAnchor = undefined; pageMenuKind = undefined;
    const focus = pageMenuFocus; pageMenuFocus = '';
    if (window && !window.isDestroyed()) {
      if (focus) window.focus();
      notifyPageMenu(false, focus, kind);
    }
  });
  const params = new URLSearchParams({ theme: bounds.dark ? 'dark' : 'light', keyboard: String(bounds.keyboard) });
  try {
    await popup.loadURL(`${pageMenuUrl}?${params}`);
    if (popup.isDestroyed() || pageMenu !== popup) return;
    notifyPageMenu(true, '', kind);
    popup.show();
  } catch (error) {
    if (!popup.isDestroyed()) { closePageMenu(); throw error; }
  }
}
function connection() { const snapshot = store.snapshot(); return snapshot.connections.find(item => item.id === snapshot.selected); }
function notifySidebar() {
  if (window && !window.isDestroyed()) window.webContents.send('shell:sidebar-state', { available: sidebarAvailable, open: sidebarOpen });
}
function sendWorkspaceSurface() {
  if (view && !view.webContents.isDestroyed()) view.webContents.send('workspace:surface', { sidebarOnly: page !== 'workspace', sidebarOpen });
}
function notifyWorkspaceHeader(value) {
  workspaceHeader = value;
  if (window && !window.isDestroyed()) window.webContents.send('shell:workspace-header', value);
}
function cleanWorkspaceHeader(value) {
  if (!value || !['conversation', 'cli'].includes(value.kind) || typeof value.dark !== 'boolean') return null;
  const clean = text => typeof text === 'string' ? text.slice(0, 500).replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : null;
  const name = clean(value.name), title = clean(value.title), status = clean(value.status);
  if (name === null || title === null || status === null || !name || (value.kind === 'cli' && !['start', 'stop'].includes(value.action)) || (value.searchAvailable !== undefined && typeof value.searchAvailable !== 'boolean')) return null;
  return { kind: value.kind, name, title, status, dark: value.dark, searchAvailable: value.searchAvailable !== false, ...(value.kind === 'cli' ? { action: value.action } : {}) };
}
function validWorkspaceSender(event) {
  if (!view || event.sender !== view.webContents || event.senderFrame !== view.webContents.mainFrame) return false;
  try { const url = new URL(event.senderFrame.url); return url.origin === selectedOrigin && url.pathname === '/'; }
  catch { return false; }
}
function destroyView() {
  if (!view) return;
  window.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close(); view = undefined; selectedId = undefined; selectedOrigin = undefined; workspaceLoadFailed = false;
  sidebarAvailable = false; notifySidebar(); notifyWorkspaceHeader(null);
}
function applyLayout() {
  if (!view) return;
  const bounds = viewBounds;
  const visible = page === 'workspace' && !!bounds && !authorizationVisible && !shellModalVisible && !workspaceLoadFailed;
  sendWorkspaceSurface();
  view.setVisible(visible);
  if (!visible) return;
  const [width, height] = window.getContentSize();
  const x = Math.max(0, Math.min(width, bounds.x));
  const y = Math.max(0, Math.min(height, bounds.y));
  view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, bounds.width)), height: Math.max(0, Math.min(height - y, bounds.height)) });
}
async function openSelected(pathname = '/') {
  if (!['/', '/account'].includes(pathname)) throw new Error('页面无效');
  destroyView();
  const item = connection();
  if (!item) { notifyStatus('idle', '请选择连接'); return; }
  let destination = item.url;
  if (item.local) {
    const gateway = gatewayManager.snapshot();
    if (!gateway.managed || gateway.state !== 'ready' || item.url !== gateway.origin) { notifyStatus('error', gateway.message); return; }

  }
  selectedId = item.id;
  const target = new URL(destination);
  selectedOrigin = target.origin;
  // No persist: prefix: cookies and all web storage exist only for this application run.
  const isolated = session.fromPartition(`hajimink-${item.id}`);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedViewRequest(details.url, target.origin) }));
  if (!configuredSessions.has(isolated)) {
    isolated.on('will-download', event => event.preventDefault());
    isolated.on('select-webauthn-account', (_event, details, callback) => {
      let replied = false;
      const reply = value => { if (replied) return; replied = true; try { callback(value); } catch {} };
      const currentAccounts = () => {
        const current = connection();
        if (!current || current.id !== item.id || selectedId !== item.id || authorizationVisible || !view || !window || window.isDestroyed()) return [];
        const expectedOrigin = current.url;
        return eligibleAccounts(details, view.webContents, expectedOrigin);
      };
      const accounts = currentAccounts();
      if (!accounts.length) { reply(); return; }
      if (accounts.length === 1) { reply(accounts[0].credentialId); return; }
      const buttons = accounts.map((account, index) => `${index + 1}. ${account.label}`).concat('取消');
      void dialog.showMessageBox(window, { type: 'question', title: '选择通行密钥', message: '请选择用于登录的通行密钥', buttons, cancelId: accounts.length, defaultId: accounts.length, noLink: true }).then(result => {
        const selected = accounts[result.response];
        if (!selected || !currentAccounts().some(account => account.credentialId === selected.credentialId)) reply();
        else reply(selected.credentialId);
      }).catch(() => reply());
    });
    isolated.webRequest.onCompleted((details) => {
      try { const url = new URL(details.url); const current = store.snapshot().connections.find(value => value.id === item.id); if (details.method === 'POST' && current && url.origin === current.url && ['/api/auth/logout', '/api/auth/logout-all'].includes(url.pathname) && details.statusCode === 200) void credentials.remove(item.id).catch(() => {}); } catch {}
    });
    configuredSessions.add(isolated);
  }
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  view = new WebContentsView({ webPreferences: { session: isolated, preload: path.join(__dirname, 'workspace-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  const content = view.webContents;
  let responseStatus = 0, loadFailed = false;
  content.setWindowOpenHandler(() => ({ action: 'deny' }));
  content.on('will-navigate', (event, navigation) => {
    const url = typeof navigation === 'string' ? navigation : navigation.url;
    try { if (new URL(url).origin !== target.origin) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  content.on('will-redirect', (event, navigation) => {
    const url = typeof navigation === 'string' ? navigation : navigation.url;
    try { if (new URL(url).origin !== target.origin) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  content.on('did-start-loading', () => { responseStatus = 0; loadFailed = false; if (content === view?.webContents) { workspaceLoadFailed = false; sidebarAvailable = false; notifySidebar(); notifyWorkspaceHeader(null); applyLayout(); notifyStatus('loading', '正在连接'); } });
  content.on('did-navigate', (_event, _url, code) => { responseStatus = code; });
  content.on('did-finish-load', () => { if (content === view?.webContents && !loadFailed) notifyStatus(responseStatus >= 400 ? 'error' : 'ready', responseStatus >= 400 ? `网关返回 HTTP ${responseStatus}，请检查地址或登录方式` : '页面已加载'); });
  content.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && content === view?.webContents) {
      loadFailed = true;
      workspaceLoadFailed = true; applyLayout();
      notifyStatus('error', code <= -200 && code >= -299 ? 'HTTPS 证书无效或不受信任，请检查地址和证书' : '连接失败，请检查网关地址和服务状态');
    }
  });
  content.on('render-process-gone', () => { if (content === view?.webContents) { workspaceLoadFailed = true; applyLayout(); notifyStatus('error', '工作台页面已退出，请重新连接'); } });
  window.contentView.addChildView(view); applyLayout();
  if (item.local && gatewayManager.snapshot().mode === 'owner') {
    try {
      const expected = gatewayManager.snapshot();
      const ticket = await gatewayManager.localSession(expected);
      if (selectedId !== item.id || content !== view?.webContents) return;
      await isolated.cookies.set({ url: `${item.url}/`, name: 'ac_owner_dev', value: ticket.token, httpOnly: true, sameSite: 'strict', path: '/', expirationDate: ticket.expiresAt / 1000 });
    } catch (error) {
      if (content === view?.webContents) { workspaceLoadFailed = true; applyLayout(); notifyStatus('error', error?.message || '无法验证本机网关，请停止旧版网关后重试'); }
      return;
    }
  }
  if (!item.local && target.protocol === 'https:') {
    const credential = await credentials.get(item);
    if (credential && selectedId === item.id && content === view?.webContents) {
      try { await isolated.cookies.set({ url: `${item.url}/`, name: '__Host-ac_device', value: credential.token, secure: true, httpOnly: true, sameSite: 'strict', path: '/', expirationDate: credential.expiresAt / 1000 }); }
      catch { notifyStatus('error', '无法恢复设备登录，请重新授权'); }
    }
  }
  if (selectedId === item.id && content === view?.webContents) void content.loadURL(new URL(pathname, target.origin).href).catch(() => {});
}
function state() {
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const saved = !!natappSaved && same(natappDraft.binaryPath, natappSaved.binaryPath) && same(natappDraft.configPath, natappSaved.configPath);
  return { ...store.snapshot(), dark: nativeTheme.shouldUseDarkColors, platform: process.platform, status: viewStatus, sidebar: { available: sidebarAvailable, open: sidebarOpen }, workspaceHeader, authorization: authorizationStatus, gateway: shellGateway(gatewayManager?.snapshot() || null), tunnel: tunnelStatus?.snapshot() || null, exit: exitCoordinator?.snapshot() || { phase: 'idle', message: '' }, natappConfig: { ...natappDraft, saved, error: natappSettingsError }, version: app.getVersion() };
}
function showWindow() { if (!window || window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate({ busy: !!exitCoordinator?.busy, showWindow, requestExit: () => { void exitCoordinator.request(); } })));
}

const haveLock = app.requestSingleInstanceLock();
if (!haveLock) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    store = new ConnectionStore(app.getPath('userData'), process.platform, configuredGatewayPort);
    nativeTheme.themeSource = store.snapshot().theme;
    nativeTheme.on('updated', syncTheme);
    const savedGatewayPort = store.localPort() ?? configuredGatewayPort;
    credentials = new DeviceCredentials(app.getPath('userData'), safeStorage);
    deviceFlow = new DeviceFlow({
      openBrowser: url => shell.openExternal(url),
      onState: value => { authorizationStatus = value; if (window && !window.isDestroyed()) window.webContents.send('shell:authorization', value); },
      onGranted: (item, grant, valid) => {
        // A canceled exchange must finish cleanup before another grant can be saved.
        const operation = credentialCommit.then(async () => {
          if (!valid() || connection()?.id !== item.id || connection()?.url !== item.url) return false;
          const isolated = session.fromPartition(`hajimink-${item.id}`);
          try {
            const protection = await credentials.save(item, grant);
            if (!valid() || connection()?.id !== item.id || connection()?.url !== item.url) { await credentials.remove(item.id); return false; }
            await isolated.cookies.set({ url: `${item.url}/`, name: '__Host-ac_device', value: grant.token, secure: true, httpOnly: true, sameSite: 'strict', path: '/', expirationDate: grant.expiresAt / 1000 });
            if (!valid() || connection()?.id !== item.id || connection()?.url !== item.url) { await isolated.cookies.remove(`${item.url}/`, '__Host-ac_device'); await credentials.remove(item.id); return false; }
            void openSelected(); return protection;
          } catch { await isolated.cookies.remove(`${item.url}/`, '__Host-ac_device').catch(() => {}); await credentials.remove(item.id).catch(() => {}); return false; }
        });
        credentialCommit = operation.catch(() => {}); return operation;
      }
    });
    const gatewayRoot = app.isPackaged ? path.join(process.resourcesPath, 'gateway') : path.resolve(__dirname, '..', '.local', 'hajimink-stage');
    gatewayManager = new ControllerGatewayManager({ appRoot: gatewayRoot, dataDir: path.join(app.getPath('userData'), 'gateway'), port: savedGatewayPort, nodePath: app.isPackaged ? path.join(gatewayRoot, 'runtime', 'node.exe') : process.execPath, runAsNode: !app.isPackaged });
    try { natappSaved = await readNatappSettings(gatewayManager.dataDir); if (natappSaved) natappDraft = { binaryPath: natappSaved.binaryPath, configPath: natappSaved.configPath }; }
    catch { natappSettingsError = 'NATAPP 配置记录无法读取，请重新选择文件。'; }
    await gatewayManager.refreshNatapp();
    tunnelStatus = new ExternalTunnelStatus();
    tunnelStatus.on('state', notifyTunnel);
    tunnelStatus.setContext(store.snapshot().setup.tunnelProvider, shellGateway(gatewayManager.snapshot()));
    gatewayManager.on('state', notifyGateway);
    const shouldStartGateway = process.platform === 'win32' && store.snapshot().connections.some(item => item.local === true);
    const files = new Map([['/index.html', ['shell.html', 'text/html; charset=utf-8']], ['/shell.css', ['shell.css', 'text/css; charset=utf-8']], ['/providers.js', ['providers.cjs', 'text/javascript; charset=utf-8']], ['/shell.js', ['shell.js', 'text/javascript; charset=utf-8']], ['/help.css', ['help.css', 'text/css; charset=utf-8']], ['/help-content.js', ['help-content.js', 'text/javascript; charset=utf-8']], ['/page-menu.html', ['page-menu.html', 'text/html; charset=utf-8']], ['/page-menu.css', ['page-menu.css', 'text/css; charset=utf-8']], ['/page-menu.js', ['page-menu.js', 'text/javascript; charset=utf-8']], ['/icon.png', ['assets/icon.png', 'image/png']]]);
    protocol.handle('hajimink', async request => {
      const url = new URL(request.url); const entry = url.hostname === 'app' && request.method === 'GET' ? files.get(url.pathname) : undefined;
      if (!entry) return new Response('Not found', { status: 404 });
      const body = await fs.readFile(path.join(__dirname, entry[0]));
      return new Response(body, { headers: { 'content-type': entry[1], 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'", 'x-content-type-options': 'nosniff' } });
    });
    const initialDark = nativeTheme.shouldUseDarkColors;
    window = new BrowserWindow({ width: 1320, height: 850, minWidth: 820, minHeight: 600, title: 'HajiMink · 哈基米 AI 工作台', show: false, autoHideMenuBar: true, backgroundColor: initialDark ? '#1b1b1a' : '#f7f7f5', ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: initialDark ? '#1b1b1a' : '#f7f7f5', symbolColor: initialDark ? '#efefeb' : '#20201e', height: 40 } } : {}), icon: path.join(__dirname, 'assets/icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
    if (process.platform !== 'darwin') window.removeMenu();
    syncTheme();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, navigation) => { const url = typeof navigation === 'string' ? navigation : navigation.url; if (url !== shellUrl) event.preventDefault(); });
    window.on('close', event => { if (!quitting) { event.preventDefault(); if (tray && process.platform !== 'linux') window.hide(); else window.minimize(); } });
    window.on('resize', () => { closePageMenu(); applyLayout(); });
    window.on('move', () => closePageMenu());
    window.on('hide', () => closePageMenu());
    window.on('minimize', () => closePageMenu());
    exitCoordinator = new ExitCoordinator({
      inspect: () => gatewayManager.inspectForExit(),
      confirm: async services => {
        showWindow();
        const names = [services.gateway && '本机网关', services.natapp && 'HajiMink 管理的 NATAPP'].filter(Boolean).join('、');
        const answer = await dialog.showMessageBox(window, { type: 'question', title: '退出 HajiMink', message: '停止本机服务并退出？', detail: `将停止${names}，下次打开时尝试恢复。工作台中的 CLI 终端会断开，Codex 桌面会话的任务不会停止。其他服务商客户端需要自行管理。`, buttons: ['取消', '退出软件'], defaultId: 0, cancelId: 0, noLink: true });
        return answer.response === 1;
      },
      stop: inspected => gatewayManager.stopForExit(store, inspected),
      quit: () => setTimeout(() => { quitting = true; app.quit(); }, 100),
      notify: value => { if (window && !window.isDestroyed()) window.webContents.send('shell:exit-state', value); if (value.phase === 'failed') showWindow(); updateTrayMenu(); }
    });
    const image = nativeImage.createFromPath(path.join(__dirname, 'assets/tray.png'));
    try {
      if (!image.isEmpty()) {
        tray = new Tray(image); tray.setToolTip('HajiMink · 哈基米 AI 工作台');
        updateTrayMenu();
        tray.on('click', showWindow);
      }
    } catch { tray = undefined; }
    for (const [name, handler] of Object.entries({
      'shell:state': () => state(),
      'shell:quit': () => exitCoordinator.request(),
      'shell:probe': value => probeConnection(value),
      'shell:gateway-probe-draft': value => probeConnection(value, { publicDraft: true }),
      'shell:gateway-public-probe': async value => {
        const before = shellGateway(await gatewayManager.refresh());
        if (before.publicOrigin === PENDING_PUBLIC_ORIGIN) throw new Error('请先填写服务商提供的真实 HTTPS 地址');
        const provider = store.snapshot().setup.tunnelProvider;
        tunnelStatus.setContext(provider, before);
        // Validate before changing status or issuing requests. A mistyped or
        // unsaved address must not overwrite the saved entry's last result.
        const target = publicProbeTarget(value, before);
        const revision = tunnelStatus.begin();
        try {
          let result = await probePublicGateway({ url: target }, before);
          const stillCurrent = after => provider === store.snapshot().setup.tunnelProvider && !['state', 'mode', 'managed', 'pid', 'controllerPid', 'port', 'publicOrigin', 'setupPending', 'streamDiagnostic'].some(key => before[key] !== after[key]) && tunnelStatus.isCurrent(revision);
          const stale = after => { tunnelStatus.setContext(store.snapshot().setup.tunnelProvider, after); return { state: 'stale', message: '检查期间网关或连接方式发生变化，请重新检查。' }; };
          let after = shellGateway(await gatewayManager.refresh());
          if (!stillCurrent(after)) return stale(after);
          result = await completePublicDiagnostic(result, before.streamDiagnostic, async () => {
            const ticket = await gatewayManager.streamTicket(before);
            after = shellGateway(await gatewayManager.refresh());
            if (!stillCurrent(after)) return false;
            // The Windows runtime includes the locked ws production package.
            const WebSocket = require(path.join(gatewayRoot, 'node_modules', 'ws'));
            return probePublicStream(target, ticket, { WebSocket });
          });
          after = shellGateway(await gatewayManager.refresh());
          if (!stillCurrent(after)) return stale(after);
          tunnelStatus.finish(revision, result);
          return result;
        } catch (error) {
          tunnelStatus.finish(revision, { state: 'unreachable' });
          throw error;
        }
      },
      'shell:provider-guide': async provider => { await shell.openExternal(providerGuide(provider)); return state(); },
      'shell:gateway-provider': value => { store.setTunnelProvider(value); tunnelStatus.setContext(store.snapshot().setup.tunnelProvider, shellGateway(gatewayManager.snapshot())); return state(); },
      'shell:gateway-disable-remote': async () => {
        const answer = await dialog.showMessageBox(window, { type: 'warning', title: '关闭远程访问', message: '请先关闭所有外部隧道和端口转发', detail: 'HajiMink 只能停止由它管理的 NATAPP。其他服务商客户端、反向代理和端口映射需要自行关闭。本机网关仍保留现有登录保护和账户数据。', buttons: ['取消', '已关闭其他转发，继续'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) return { canceled: true, state: state() };
        const observed = await gatewayManager.refreshNatapp();
        if (['running', 'unconfirmed'].includes(observed.natapp?.state)) {
          const stopped = await gatewayManager.natappAction('stop', store);
          if (['running', 'unconfirmed'].includes(stopped.natapp?.state)) throw new Error('无法确认 NATAPP 已停止，远程访问设置未更改');
        }
        store.disableRemote();
        tunnelStatus.setContext(null, shellGateway(gatewayManager.snapshot()));
        return { canceled: false, state: state() };
      },
      'shell:natapp-select': async kind => {
        if (process.platform !== 'win32' || !['binary', 'config'].includes(kind)) throw new Error('无法选择 NATAPP 文件');
        const result = await dialog.showOpenDialog(window, { title: kind === 'binary' ? '选择 NATAPP 客户端' : '选择 NATAPP 配置文件', properties: ['openFile'], filters: kind === 'binary' ? [{ name: 'NATAPP 客户端', extensions: ['exe'] }] : [{ name: 'NATAPP 配置', extensions: ['ini'] }] });
        if (!result.canceled && result.filePaths.length === 1) natappDraft = { ...natappDraft, [kind === 'binary' ? 'binaryPath' : 'configPath']: result.filePaths[0] };
        return state();
      },
      'shell:natapp-save': async () => {
        natappSaved = await gatewayManager.configureNatapp(natappDraft, store);
        natappDraft = { binaryPath: natappSaved.binaryPath, configPath: natappSaved.configPath }; natappSettingsError = '';
        await gatewayManager.refreshNatapp(); return state();
      },
      'shell:natapp-action': async action => {
        if (!['start', 'stop', 'refresh'].includes(action)) throw new Error('NATAPP 操作无效');
        if (action === 'start' && (store.snapshot().setup.tunnelProvider !== 'natapp' || !state().natappConfig.saved)) throw new Error('请先选择 NATAPP 并保存客户端文件');
        if (action === 'refresh') await gatewayManager.refreshNatapp(); else await gatewayManager.natappAction(action, store);
        return state();
      },
      'shell:gateway-start': async () => { const result = await gatewayManager.startByUser(store); if (connection()?.local) void openSelected(); if (result.preferenceError) throw new Error(result.message); return state(); },
      'shell:gateway-stop': async () => { const result = await gatewayManager.stopByUser(store); if (connection()?.local) void openSelected(); if (result.preferenceError) throw new Error(result.message); return state(); },
      'shell:gateway-restart': async () => { const result = await gatewayManager.restartByUser(store); if (connection()?.local) void openSelected(); if (result.preferenceError) throw new Error(result.message); return state(); },
      'shell:gateway-port': async port => { try { await gatewayManager.changePort(port, store); } finally { if (connection()?.local) await openSelected(); } return state(); },
      'shell:gateway-account': async () => {
        if (gatewayManager.snapshot().publicOrigin === PENDING_PUBLIC_ORIGIN) throw new Error('请先填写真实 HTTPS 地址');
        const local = store.snapshot().connections.find(item => item.local);
        if (!local) throw new Error('找不到本机连接');
        const gateway = await gatewayManager.startForAccount(store);
        if (gateway.state !== 'ready') throw new Error(gateway.message || '请先启动本机网关');
        store.select(local.id); await openSelected('/account'); return state();
      },
      'shell:gateway-enable-owner': async value => {
        const origin = normalizeAddress(value);
        try { await gatewayManager.enableOwner(origin); } finally { if (connection()?.local) await openSelected(); }
        return state();
      },
      'shell:gateway-passkey-setup': async value => {
        const origin = normalizeAddress(value);
        setupNavigationBinding = null;
        let result;
        try { result = await gatewayManager.beginPasskeySetup(origin); } finally { if (connection()?.local) await openSelected(); }
        setupNavigationBinding = createSetupBinding(shellGateway(result.gateway), result.expiresAt);
        return { state: state(), code: result.code, expiresAt: result.expiresAt };
      },
      'shell:gateway-prepare-address': async () => {
        // The provisional setup secret is intentionally discarded and never sent to the renderer.
        try { await gatewayManager.prepareAwaitingOrigin(); } finally { if (connection()?.local) await openSelected(); }
        return state();
      },
      'shell:gateway-bind-pending-address': async value => {
        const origin = normalizeAddress(value);
        setupNavigationBinding = null;
        let result;
        try { result = await gatewayManager.bindPendingOrigin(origin); } finally { if (connection()?.local) await openSelected(); }
        setupNavigationBinding = createSetupBinding(shellGateway(result.gateway), result.expiresAt);
        return { state: state(), code: result.code, expiresAt: result.expiresAt };
      },
      'shell:gateway-open-setup': async value => {
        const binding = setupNavigationBinding;
        if (!binding) throw new Error('请先在本机生成当前设置码');
        const gateway = shellGateway(await gatewayManager.refresh());
        const target = setupNavigationUrl(binding, gateway, value?.url);
        if (binding !== setupNavigationBinding) throw new Error('网关或设置码已变化，请在本机重新生成设置码');
        // A consumed setup code cannot be opened in another browser session.
        const bootstrap = await readBootstrap(gateway.port, { mode: 'owner', publicOrigin: binding.origin });
        if (!bootstrap || bootstrap.mode !== 'owner' || typeof bootstrap.setupCodeAvailable !== 'boolean') throw new Error('无法确认本机设置状态，请检查网关后重试');
        if (binding !== setupNavigationBinding) throw new Error('网关或设置码已变化，请在本机重新生成设置码');
        setupNavigationUrl(binding, shellGateway(gatewayManager.snapshot()), value?.url);
        if (!bootstrap.setupPending || !bootstrap.setupCodeAvailable) {
          setupNavigationBinding = null;
          return { status: 'unavailable' };
        }
        await shell.openExternal(target);
        return { status: 'opened' };
      },
      'shell:gateway-logs': async () => gatewayManager.logsSnapshot(),
      'shell:setup-complete': () => { const gateway = gatewayManager.snapshot(); if (!gateway.managed || gateway.state !== 'ready') throw new Error('请先启动并检查本机网关'); if (gateway.publicOrigin === PENDING_PUBLIC_ORIGIN) throw new Error('请先填写真实 HTTPS 地址'); if (gateway.setupPending) throw new Error('请先完成首次登录设置'); store.completeSetup(); return state(); },
      'shell:add': value => { store.add(value); deviceFlow.cancel(); void openSelected(); return state(); },
      'shell:edit': async (id, value) => { const old = store.snapshot().connections.find(item => item.id === id); store.edit(id, value); if (deviceFlow.active?.item.id === id) deviceFlow.cancel(); if (old && old.url !== store.snapshot().connections.find(item => item.id === id)?.url) { if (selectedId === id) destroyView(); await credentials.remove(id); await session.fromPartition(`hajimink-${id}`).clearStorageData(); } if (store.snapshot().selected === id) void openSelected(); return state(); },
      'shell:remove': async id => { store.remove(id); if (deviceFlow.active?.item.id === id) deviceFlow.cancel(); if (selectedId === id) destroyView(); await credentials.remove(id); await session.fromPartition(`hajimink-${id}`).clearStorageData(); void openSelected(); return state(); },
      'shell:select': async id => { store.select(id); deviceFlow.cancel(); if (connection()?.local) await gatewayManager.startForSelection(store); void openSelected(); return state(); },
      'shell:authorize': () => { const item = connection(); if (!item || item.local || new URL(item.url).protocol !== 'https:') throw new Error('请选择使用 HTTPS 的远程网关'); authorizationVisible = true; applyLayout(); void deviceFlow.start(item); return state(); },
      'shell:authorize-cancel': () => { deviceFlow.cancel(); authorizationVisible = false; applyLayout(); return state(); },
      'shell:page': value => { if (!desktopPages.includes(value)) throw new Error('页面无效'); page = value; applyLayout(); return state(); },
      'shell:theme': value => { store.setTheme(value); closePageMenu(); nativeTheme.themeSource = store.snapshot().theme; syncTheme(); return state(); },
      'shell:page-menu-open': value => openPageMenu(value),
      'shell:reload': () => { if (connection()?.local && gatewayManager.snapshot().mode === 'owner') void openSelected(); else if (view) view.webContents.reload(); else void openSelected(); return state(); }
    })) ipcMain.handle(name, (event, ...args) => {
      validSender(event);
      if (exitCoordinator?.busy && !['shell:state', 'shell:quit'].includes(name)) throw new Error('正在处理退出，请稍候');
      return handler(...args);
    });
    ipcMain.on('shell:layout', (event, bounds) => { try { validSender(event); if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 50000)) return; viewBounds = bounds; applyLayout(); } catch {} });
    ipcMain.on('shell:sidebar-open', (event, value) => { try { validSender(event); if (typeof value !== 'boolean') return; sidebarOpen = value; notifySidebar(); applyLayout(); } catch {} });
    ipcMain.on('shell:modal-visible', (event, value) => { try { validSender(event); if (typeof value !== 'boolean') return; shellModalVisible = value; applyLayout(); } catch {} });
    ipcMain.on('shell:page-menu-dismiss', event => { try { validSender(event); closePageMenu(); } catch {} });
    ipcMain.handle('page-menu:data', event => {
      if (!validPageMenuSender(event) || pageMenuKind !== 'connection') throw new Error('不允许此操作');
      const snapshot = store.snapshot();
      return { kind: 'connection', selected: snapshot.selected, items: snapshot.connections.map(({ id, name, local }) => ({ id, name, local })) };
    });
    ipcMain.on('page-menu:choose', (event, value) => {
      if (!validPageMenuSender(event) || pageMenuKind !== 'connection') return;
      const snapshot = store.snapshot();
      if (!snapshot.connections.some(item => item.id === value)) return;
      closePageMenu('trigger');
      if (value !== snapshot.selected) window.webContents.send('shell:select-connection', value);
    });
    ipcMain.on('page-menu:close', (event, focus) => { if (!validPageMenuSender(event) || !['trigger', 'next'].includes(focus)) return; closePageMenu(focus); });
    ipcMain.on('workspace:page-menu-dismiss', event => { if (validWorkspaceSender(event)) closePageMenu(); });
    ipcMain.on('workspace:ready', event => { if (!validWorkspaceSender(event)) return; sidebarAvailable = true; notifySidebar(); syncTheme(); applyLayout(); });
    ipcMain.on('workspace:sidebar-open', (event, value) => { if (!validWorkspaceSender(event) || typeof value !== 'boolean') return; sidebarOpen = value; notifySidebar(); applyLayout(); });
    ipcMain.on('workspace:show', event => { if (!validWorkspaceSender(event) || page === 'workspace') return; window.webContents.send('shell:show-workspace'); });
    ipcMain.on('workspace:show-settings', event => { if (!validWorkspaceSender(event)) return; window.webContents.send('shell:show-settings'); });
    ipcMain.on('workspace:header', (event, value) => { if (!validWorkspaceSender(event)) return; const header = cleanWorkspaceHeader(value); if (header) notifyWorkspaceHeader(header); });
    ipcMain.on('shell:workspace-header-action', (event, value) => { try { validSender(event); if (page === 'workspace' && view && workspaceHeader?.kind === 'cli' && workspaceHeader.action === value) view.webContents.send('workspace:header-action', value); } catch {} });
    ipcMain.on('shell:workspace-search', event => { try { validSender(event); if (page === 'workspace' && workspaceHeader?.searchAvailable !== false && view && !view.webContents.isDestroyed()) view.webContents.send('workspace:search'); } catch {} });
    await window.loadURL(shellUrl);
    openSelected();
    if (shouldStartGateway) {
      // A manually stopped gateway stays stopped. Existing verified controllers
      // can still be reattached without creating a new process.
      void gatewayManager.startAccordingToPolicy(store).then(() => { if (connection()?.local) void openSelected(); });
    }
    showWindow();
  }).catch(error => { console.error('HajiMink 启动失败:', error.message); dialog.showErrorBox('HajiMink 无法启动', '连接配置无法读取或应用无法初始化。请先备份 HajiMink 用户数据，再检查配置和诊断日志。'); app.quit(); });
  app.on('activate', showWindow);
  app.on('before-quit', event => {
    if (exitCoordinator?.busy && exitCoordinator.snapshot().phase !== 'quitting') { event.preventDefault(); showWindow(); return; }
    quitting = true; deviceFlow?.cancel(); tunnelStatus?.close(); gatewayManager?.close();
  });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
