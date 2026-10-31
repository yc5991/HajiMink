'use strict';
const $ = selector => document.querySelector(selector);
let state, currentPage = 'workspace', settingsSection = 'interface', editing = null, toastTimer, setupCodeTimer, probeRevision = 0, publicProbeRevision = 0, publicProbeBasis = '', publicProbing = false, portSaving = false, ownerSaving = false, providerSaving = false;
let sidebar = { available: false, open: true };
let workspaceHeader = null;
let lastResumeError = '';
let gatewayBusy = false;
// Keep a user's unsaved address across blur, status updates and async actions.
let originDraftDirty = false, originDraftRevision = 0, setupCodeBinding = null, setupOpening = false, natappBusy = false;
const dialog = $('#connection-dialog');
const authorizationDialog = $('#authorization-dialog');
const gatewayLabels = { stopped: '未启动', starting: '启动中', ready: '正常', stopping: '停止中', error: '故障', unsupported: '暂不支持' };
const pageLabels = Object.freeze({ workspace: true, settings: true });
const settingsSectionIds = Object.freeze({ interface: 'settings-interface', connections: 'settings-connections', gateway: 'gateway', documentation: 'settings-documentation', logs: 'logs', about: 'settings-about' });
const providerCatalog = window.HajiminkProviders.CATALOG;
const providers = Object.fromEntries(providerCatalog.map(provider => [provider.id, provider]));
const providerOption = provider => new Option(provider.optionLabel || provider.label, provider.id);
$('#provider').replaceChildren(...providerCatalog.map(providerOption));
const tunnelProviders = providerCatalog.filter(provider => provider.tunnel);
$('#gateway-provider').replaceChildren(new Option('选择连接方式', ''), new Option('关闭远程访问', 'off'), ...[...tunnelProviders.filter(provider => provider.guide), ...tunnelProviders.filter(provider => !provider.guide)].map(providerOption));
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 4500); }
function formatError(error) { return String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
function reconcileOriginDraft(submittedRevision, committed) {
  if (submittedRevision === originDraftRevision) { if (committed) originDraftDirty = false; return; }
  const gateway = state?.gateway;
  const saved = gateway?.mode === 'owner' && !gateway.awaitingPublicOrigin ? gateway.publicOrigin : null;
  originDraftDirty = !saved || $('#gateway-public-origin').value !== saved;
}
function clearSetupCode() { clearTimeout(setupCodeTimer); setupCodeBinding = null; $('#gateway-setup-code').textContent = ''; $('#gateway-setup-code-origin').textContent = ''; $('#gateway-setup-code-expiry').textContent = ''; $('#gateway-open-setup-feedback').textContent = ''; $('#gateway-setup-code-panel').hidden = true; }
function status(value) { if (state) state.status = value; const node = $('#connection-status'); node.className = `status ${value.state}`; node.title = value.message; node.setAttribute('aria-label', value.message); node.querySelector('span').textContent = value.message; renderWorkspaceFallback(); }
function renderWorkspaceFallback() {
  if (!state) return;
  const selected = state.connections.find(item => item.id === state.selected), gateway = state.gateway, connection = state.status || {};
  const title = $('#fallback-title'), detail = $('#fallback-detail'), settings = $('#fallback-settings'), retry = $('#fallback-retry');
  retry.hidden = false; settings.hidden = false;
  if (!selected) {
    title.textContent = '选择工作台连接'; detail.textContent = '添加或选择一个网关后即可使用。'; settings.textContent = '管理连接'; settings.dataset.section = 'connections'; retry.hidden = true;
  } else if (selected.local) {
    title.textContent = gateway?.state === 'starting' ? '正在启动本机网关' : gateway?.awaitingPublicOrigin ? '完成网关设置' : '本机网关未连接';
    detail.textContent = gateway?.awaitingPublicOrigin ? '请在网关设置中填写访问地址。' : (gateway?.message || '请检查本机网关状态。');
    settings.textContent = '网关设置'; settings.dataset.section = 'gateway'; retry.hidden = gateway?.state === 'starting';
  } else {
    title.textContent = connection.state === 'loading' ? '正在连接网关' : '远程网关未连接';
    detail.textContent = connection.state === 'loading' ? `正在连接 ${selected.name}。` : (connection.message || '请检查地址和网关服务状态。');
    settings.textContent = '管理连接'; settings.dataset.section = 'connections'; retry.hidden = connection.state === 'loading';
  }
}
function renderDesktopStatus(gateway) {
  const badge = $('#desktop-state-badge'), message = $('#desktop-state-message'), detail = $('#desktop-state-detail');
  const desktop = gateway?.state === 'ready' && gateway.managed ? gateway.desktop : null;
  $('#desktop-state-version').textContent = desktop?.version || '未检测到';
  if (!gateway || gateway.state === 'unsupported') {
    badge.textContent = '暂不支持'; message.textContent = '此系统尚不支持本机 Codex'; detail.textContent = '';
  } else if (gateway.state !== 'ready' || !gateway.managed) {
    badge.textContent = '未检测'; message.textContent = '启动网关后检查'; detail.textContent = '';
  } else if (!desktop) {
    badge.textContent = '等待状态'; message.textContent = '暂未获取桌面状态'; detail.textContent = '';
  } else if (desktop.connected && desktop.accessMode === 'full' && desktop.compatible) {
    badge.textContent = '已连接'; message.textContent = 'Codex 已连接'; detail.textContent = '';
  } else if (desktop.connected && desktop.accessMode === 'limited' && desktop.compatible) {
    badge.textContent = '部分可用'; message.textContent = 'Codex 已连接，部分功能可用'; detail.textContent = '支持项目内新建、空闲会话发送和停止；追加消息、模型设置和审批请在 Codex 中处理。';
  } else if (desktop.connected && desktop.accessMode === 'read-only' && !desktop.compatible) {
    badge.textContent = '仅查看'; message.textContent = 'Codex 已连接，当前只读'; detail.textContent = '可以查看会话；发送、停止和审批等操作尚未验证，请在 Codex 中处理。';
  } else {
    badge.textContent = '未连接'; message.textContent = 'Codex 尚未连接'; detail.textContent = desktop.reason || '请确认 Codex 桌面应用正在运行，再检查工作台提示。';
  }
}
function renderTunnelStatus(tunnel) {
  const labels = { unconfigured: '未选择', waiting: '等待网关', 'needs-protection': '待保护', 'needs-address': '待填地址', unchecked: '未检查', checking: '检查中', reachable: '入口有响应', partial: '实时待确认', restricted: '访问受限', unsafe: '需要处理', error: '检查未通过' };
  const titles = { unconfigured: '请选择连接方式', waiting: '等待网关启动', 'needs-protection': '请先保护网关', 'needs-address': '等待真实地址', unchecked: '尚未检查入口', checking: '正在检查远程入口', reachable: '远程入口有响应', partial: '网页有响应，实时待确认', restricted: '入口访问受限', unsafe: '请检查登录保护', error: '暂未确认入口' };
  const kind = tunnel?.state || 'unconfigured';
  $('#tunnel-status-badge').textContent = labels[kind] || '未检查';
  $('#tunnel-status-message').textContent = titles[kind] || '尚未检查入口';
  $('#tunnel-status-detail').textContent = tunnel?.message || '服务商客户端由你自行管理。';
  $('#tunnel-status-provider').textContent = providers[tunnel?.provider]?.label || '未选择';
  const gateway = state?.gateway;
  const savedOrigin = gateway?.mode === 'owner' && !gateway.awaitingPublicOrigin && gateway.publicOrigin ? gateway.publicOrigin : '';
  const origin = $('#tunnel-status-origin'); origin.textContent = savedOrigin || '尚未保存'; origin.title = savedOrigin;
  $('#tunnel-status-time').textContent = Number.isFinite(tunnel?.checkedAt) ? new Date(tunnel.checkedAt).toLocaleTimeString() : '尚未检查';
  $('#tunnel-status-stream').textContent = ({ passed: '一次双向检查通过', failed: '未通过检查', unchecked: '未检查' })[tunnel?.stream] || '未检查';
}
function renderNatapp(gateway) {
  const config = state?.natappConfig || {}, tunnel = gateway?.natapp;
  const selected = state?.setup?.tunnelProvider === 'natapp';
  const active = ['running', 'unconfirmed'].includes(tunnel?.state);
  $('#natapp-manager-card').hidden = !selected && !active;
  $('#natapp-binary-path').textContent = config.binaryPath || '尚未选择';
  $('#natapp-config-path').textContent = config.configPath || '尚未选择';
  $('#natapp-state').textContent = tunnel?.message || (gateway?.state === 'ready' ? '当前后台控制器不支持 NATAPP 管理，请重启网关。' : '请启动网关或刷新状态。');
  if (config.error && !$('#natapp-feedback').textContent) $('#natapp-feedback').textContent = config.error;
  const exitBusy = ['inspecting', 'confirming', 'stopping', 'quitting'].includes(state?.exit?.phase);
  const locked = natappBusy || active || exitBusy || ['starting', 'stopping'].includes(gateway?.state);
  $('#natapp-select-binary').disabled = locked || state?.platform !== 'win32';
  $('#natapp-select-config').disabled = locked || state?.platform !== 'win32';
  $('#natapp-save').disabled = locked || state?.platform !== 'win32' || !config.binaryPath || !config.configPath || config.saved;
  $('#natapp-start').disabled = locked || !selected || !config.saved || gateway?.state !== 'ready' || !gateway.managed || gateway.mode !== 'owner' || !tunnel;
  $('#natapp-stop').disabled = natappBusy || exitBusy || !active;
  $('#natapp-refresh').disabled = natappBusy || exitBusy || state?.platform !== 'win32';
}
function renderExitStatus() {
  const phase = state?.exit?.phase || 'idle';
  const busy = ['inspecting', 'confirming', 'stopping', 'quitting'].includes(phase);
  $('#settings-exit').disabled = busy;
  $('#settings-exit-feedback').textContent = state?.exit?.message || '';
}
function renderGateway() {
  const gateway = state?.gateway;
  renderNatapp(gateway);
  renderDesktopStatus(gateway);
  renderTunnelStatus(state?.tunnel);
  if (!gateway) return;
  const nextProbeBasis = JSON.stringify([gateway.state, gateway.mode, gateway.managed, gateway.pid, gateway.controllerPid, gateway.port, gateway.publicOrigin, gateway.setupPending, gateway.awaitingPublicOrigin, gateway.streamDiagnostic]);
  if (publicProbeBasis !== nextProbeBasis) { publicProbeBasis = nextProbeBasis; publicProbeRevision++; $('#gateway-remote-test-feedback').textContent = ''; }
  const pendingSetup = gateway.mode === 'owner' && gateway.setupPending === true;
  const awaitingAddress = gateway.awaitingPublicOrigin === true;
  const badge = $('#gateway-state-badge'); badge.textContent = pendingSetup && gateway.state === 'ready' ? '待设置' : (gatewayLabels[gateway.state] || gateway.state); badge.className = `tag gateway-${pendingSetup ? 'starting' : gateway.state}`;
  if (!$('#gateway-setup-code-panel').hidden && (!pendingSetup || gateway.state !== 'ready' || !gateway.managed || !setupCodeBinding || gateway.publicOrigin !== setupCodeBinding.origin || gateway.pid !== setupCodeBinding.pid || gateway.controllerPid !== setupCodeBinding.controllerPid)) {
    clearSetupCode(); $('#gateway-owner-feedback').textContent = '网关状态或地址已变化，设置码已隐藏；请核对后重新生成。';
  }
  $('#gateway-state-message').textContent = gateway.message || '本机网关未启动';
  const manualStop = state?.setup?.gatewayManuallyStopped === true;
  const manualNote = $('#gateway-manual-stop-note');
  manualNote.hidden = !manualStop;
  manualNote.textContent = !manualStop ? '' : gateway.state === 'ready' ? '已记录手动停止，但网关当前仍在运行；请检查后重试停止。' : gateway.state === 'stopped' ? '网关已手动停止；重新打开或切回本机时不会自动启动。' : '已记录手动停止，请检查网关当前状态。';
  $('#gateway-origin').textContent = gateway.origin || '-';
  $('#gateway-port').textContent = gateway.port ? String(gateway.port) : '-';
  $('#gateway-process').textContent = gateway.managed && gateway.pid ? `HajiMink · ${gateway.pid}` : '未接管';
  const busy = gatewayBusy || ['starting', 'stopping'].includes(gateway.state) || ['inspecting', 'confirming', 'stopping', 'quitting'].includes(state?.exit?.phase) || portSaving || ownerSaving || setupOpening;
  const toggle = $('#gateway-toggle');
  toggle.checked = gateway.state === 'ready' && gateway.managed;
  toggle.disabled = busy || gateway.state === 'unsupported' || (gateway.state === 'ready' && !gateway.managed);
  $('#gateway-keep-stopped').hidden = gateway.state !== 'stopped' || manualStop;
  $('#gateway-keep-stopped').disabled = busy;
  $('#gateway-restart').disabled = busy || gateway.state === 'unsupported';
  const error = $('#gateway-error'); error.hidden = gateway.state !== 'error' && !gateway.resumeError; error.textContent = gateway.state === 'error' ? gateway.message : gateway.resumeError || '';
  const input = $('#gateway-port-input');
  if (!portSaving && document.activeElement !== input && gateway.port) input.value = String(gateway.port);
  $('#gateway-port-save').disabled = portSaving || busy || gateway.state === 'unsupported' || !state.connections.some(item => item.local);
  input.disabled = portSaving || gateway.state === 'unsupported' || !state.connections.some(item => item.local);
  const owner = gateway.mode === 'owner';
  const ownerReady = owner && !pendingSetup && !awaitingAddress && gateway.state === 'ready' && gateway.managed;
  $('#gateway-remote-fields').hidden = $('#gateway-provider').value === 'off' || (!$('#gateway-provider').value && !owner);
  $('#gateway-remote-test').disabled = publicProbing || providerSaving;
  const localReady = gateway.state === 'ready' && gateway.managed;
  $('#gateway-no-address').disabled = busy || !localReady || owner;
  document.querySelector('.gateway-address-help').hidden = owner;
  $('#gateway-auth-status').textContent = awaitingAddress ? (pendingSetup ? '受限保护已开启，等待填写真实 HTTPS 地址。' : '密码保护已开启，等待填写真实 HTTPS 地址。') : pendingSetup ? `等待首次登录设置 · ${gateway.publicOrigin}` : ownerReady ? `独立登录已启用 · ${gateway.publicOrigin}` : owner ? '独立登录已配置，网关尚未确认启动。' : '当前为本机模式，尚未启用远程登录保护。';
  const authMethod = $('#gateway-auth-method').value;
  $('#gateway-auth-label').hidden = owner && !pendingSetup;
  $('#gateway-auth-method').hidden = owner && !pendingSetup;
  $('#gateway-account').textContent = owner ? '管理登录' : '设置密码';
  $('#gateway-account').disabled = ownerSaving || busy || pendingSetup || awaitingAddress || gateway.state === 'unsupported' || (manualStop && (gateway.state !== 'ready' || !gateway.managed)) || !state.connections.some(item => item.local);
  $('#gateway-account').hidden = pendingSetup || (!owner && authMethod !== 'password');
  const originInput = $('#gateway-public-origin');
  originInput.readOnly = setupOpening;
  if (owner && !awaitingAddress && !ownerSaving && !originDraftDirty && document.activeElement !== originInput) originInput.value = gateway.publicOrigin || '';
  const savedOrigin = owner && !awaitingAddress ? gateway.publicOrigin : null;
  const hasUnsavedOrigin = originDraftDirty && (!savedOrigin || originInput.value !== savedOrigin);
  const draftNote = $('#gateway-origin-draft');
  draftNote.hidden = !hasUnsavedOrigin || !savedOrigin;
  draftNote.textContent = hasUnsavedOrigin && savedOrigin ? '地址尚未保存。' : '';
  $('#gateway-origin-reset').hidden = !hasUnsavedOrigin || !savedOrigin;
  $('#gateway-origin-reset').disabled = busy;
  $('#gateway-owner-enable').textContent = awaitingAddress && !pendingSetup ? '保存地址' : owner ? '保存地址' : '启用登录';
  $('#gateway-owner-enable').hidden = pendingSetup || (!owner && authMethod === 'passkey');
  $('#gateway-owner-enable').disabled = ownerSaving || busy || pendingSetup || gateway.state === 'unsupported' || !state.connections.some(item => item.local);
  $('#gateway-passkey-start').textContent = pendingSetup ? '生成设置码' : '设置通行密钥';
  $('#gateway-passkey-start').hidden = !pendingSetup && (owner || authMethod !== 'passkey');
  $('#gateway-owner-help').hidden = authMethod !== 'passkey' || (owner && !pendingSetup);
  $('#gateway-owner-help').textContent = '通行密钥需要 HTTPS 域名。';
  $('#gateway-passkey-start').disabled = ownerSaving || busy || (owner && !pendingSetup) || gateway.state !== 'ready' || !gateway.managed || !state.connections.some(item => item.local);
  $('#gateway-open-setup').disabled = setupOpening || busy || !setupCodeBinding;
  $('#gateway-safety-title').textContent = awaitingAddress ? '等待真实访问地址' : pendingSetup ? '等待首次设置' : '先保护登录，再开放远程访问';
  $('#gateway-safety-detail').textContent = awaitingAddress ? '保护已开启，请填写真实 HTTPS 地址。' : pendingSetup ? '请在最终 HTTPS 地址完成登录设置。' : owner ? '请先确认网关已启动，不要开放隧道。' : '远程登录未启用，请勿公开网关。';
  $('#gateway-safety').hidden = ownerReady;
}
function render() {
  const select = $('#connection-select');
  const selected = state.connections.find(item => item.id === state.selected);
  const selectedLabel = selected ? (selected.local ? `${selected.name} · 本机` : selected.name) : state.connections.length ? '选择连接' : '尚未添加连接';
  select.querySelector('span').textContent = selectedLabel;
  select.title = selectedLabel;
  select.dataset.selected = state.selected || '';
  select.setAttribute('aria-label', selected ? `选择工作台连接，当前：${selectedLabel}` : '选择工作台连接');
  select.disabled = !state.connections.length;
  const list = $('#connection-list'); list.replaceChildren();
  if (!state.connections.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '还没有连接，添加一台网关开始使用。'; list.append(empty); }
  for (const item of state.connections) {
    const card = document.createElement('div'); card.className = 'connection-card';
    const details = document.createElement('div'); details.className = 'details';
    const name = document.createElement('strong'); name.textContent = item.local ? `${item.name} · 本机` : item.name;
    const address = document.createElement('small'); address.textContent = item.local ? item.url : `${providers[item.provider]?.label || providers.other.label} · ${item.url}`;
    details.append(name, address); card.append(details);
    if (item.id === state.selected) { const chosen = document.createElement('span'); chosen.className = 'chosen'; chosen.textContent = '当前连接'; card.append(chosen); }
    else { const choose = document.createElement('button'); choose.className = 'button'; choose.textContent = '连接'; choose.addEventListener('click', async () => { try { state = await window.hajimink.select(item.id); render(); await changePage('workspace'); } catch (error) { showToast(formatError(error)); } }); card.append(choose); }
    const edit = document.createElement('button'); edit.className = 'button'; edit.textContent = '编辑'; edit.setAttribute('aria-label', `编辑 ${item.name}`); edit.addEventListener('click', () => openDialog(item)); card.append(edit);
    const remove = document.createElement('button'); remove.className = 'button'; remove.textContent = '删除'; remove.setAttribute('aria-label', `删除 ${item.name}`); remove.addEventListener('click', async () => { if (!window.confirm(`删除“${item.name}”的本机连接信息？远程项目和会话不会删除。`)) return; try { state = await window.hajimink.remove(item.id); render(); } catch (error) { showToast(formatError(error)); } }); card.append(remove); list.append(card);
  }
  $('#connection-count').textContent = `${state.connections.length} 个连接`;
  $('#version').textContent = `HajiMink ${state.version}`;
  $('#authorize').hidden = !selected || selected.local || !selected.url.startsWith('https://');
  status(state.status); renderExitStatus(); renderGateway(); renderTheme();
}
function renderTheme() {
  for (const input of document.querySelectorAll('input[name="theme"]')) input.checked = input.value === (state?.theme || 'system');
}
function layout() {
  const rect = $('#view-slot').getBoundingClientRect();
  window.hajimink.layout({ x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) });
}
function renderSidebar() {
  document.body.dataset.page = currentPage;
  document.body.classList.toggle('sidebar-closed', !sidebar.open);
  const toggle = $('#shell-sidebar-open');
  toggle.hidden = currentPage !== 'workspace' || !sidebar.available;
  $('#dock-search').hidden = currentPage !== 'workspace' || !sidebar.available || workspaceHeader?.searchAvailable === false;
  toggle.setAttribute('aria-expanded', String(sidebar.open));
  toggle.setAttribute('aria-label', sidebar.open ? '隐藏侧边栏' : '显示侧边栏');
  toggle.title = sidebar.open ? '隐藏侧边栏' : '显示侧边栏';
  for (const button of document.querySelectorAll('[data-settings-section]')) {
    if (button.dataset.settingsSection === settingsSection) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  renderWorkspaceHeader();
}
function renderWorkspaceHeader() {
  const header = $('#workspace-header');
  const visible = currentPage === 'workspace' && sidebar.available && !!workspaceHeader;
  header.hidden = !visible;
  if (!visible) return;
  $('#workspace-header-name').textContent = workspaceHeader.name;
  $('#workspace-header-title').textContent = workspaceHeader.title;
  $('#workspace-header-title').title = workspaceHeader.title;
  const status = $('#workspace-header-state');
  status.textContent = workspaceHeader.status;
  status.title = workspaceHeader.status;
  status.hidden = !workspaceHeader.status;
  const action = $('#workspace-cli-action');
  action.hidden = workspaceHeader.kind !== 'cli';
  if (!action.hidden) {
    const start = workspaceHeader.action === 'start';
    const label = start ? '启动 Codex CLI' : '结束终端';
    action.setAttribute('aria-label', label); action.title = label;
    $('#workspace-cli-start').toggleAttribute('hidden', !start); $('#workspace-cli-stop').toggleAttribute('hidden', start);
  }
}
async function loadLogs() {
  try { const value = await window.hajimink.gatewayLogs(); $('#logs-output').textContent = value.lines?.join('\n') || '暂无本机网关日志'; }
  catch (error) { $('#logs-output').textContent = `读取日志失败：${formatError(error)}`; }
}
async function changePage(page) {
  if (!Object.hasOwn(pageLabels, page)) return;
  currentPage = page;
  for (const section of document.querySelectorAll('.page')) section.hidden = section.id !== page;
  renderSidebar(); layout();
  state = await window.hajimink.page(page); render();
  requestAnimationFrame(layout);
}
async function changeSettingsSection(section) {
  if (!Object.hasOwn(settingsSectionIds, section)) return;
  settingsSection = section;
  for (const panel of document.querySelectorAll('.settings-section')) panel.hidden = panel.id !== settingsSectionIds[section];
  renderSidebar();
  if (currentPage === 'settings' && section === 'logs') await loadLogs();
}
async function openSettings(section = settingsSection) {
  if (currentPage !== 'settings') await changePage('settings');
  await changeSettingsSection(section);
}
function clearProbe() { probeRevision++; $('#probe-status').textContent = ''; $('#test-connection').disabled = false; }
function updateProviderHint() { const provider = $('#provider').value; $('#provider-guide').hidden = !providers[provider]?.guide; }
function openDialog(item) {
  editing = item?.id || null;
  $('#dialog-title').textContent = editing ? '编辑连接' : '添加连接';
  $('#connection-form button[type=submit]').textContent = editing ? '保存' : '保存并连接';
  $('#provider').value = item?.provider || 'other'; $('#provider').disabled = item?.local === true;
  $('#name').value = item?.name || ''; $('#url').value = item?.url || ''; $('#url').readOnly = item?.local === true;
  $('#form-error').textContent = ''; clearProbe(); updateProviderHint(); window.hajimink.modalVisible(true); dialog.showModal(); $('#name').focus();
}
async function gatewayAction(action) {
  try { state = await window.hajimink[action](); render(); if (currentPage === 'settings' && settingsSection === 'logs') await loadLogs(); }
  catch (error) { showToast(formatError(error)); }
}
async function finishLocalSetup() {
  if (state.setup?.complete === false && state.gateway?.state === 'ready' && state.gateway.managed && !state.gateway.setupPending && !state.gateway.awaitingPublicOrigin) state = await window.hajimink.completeSetup();
}
const connectionTrigger = $('#connection-select');
connectionTrigger.addEventListener('click', async event => {
  const rect = connectionTrigger.getBoundingClientRect();
  try {
    const dark = state?.dark ?? matchMedia('(prefers-color-scheme: dark)').matches;
    await window.hajimink.openPageMenu({ kind: 'connection', x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height), dark, keyboard: event.detail === 0 });
  } catch (error) { showToast(formatError(error)); }
});
connectionTrigger.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') { event.preventDefault(); connectionTrigger.click(); }
});
document.addEventListener('pointerdown', event => {
  if (connectionTrigger.getAttribute('aria-expanded') === 'true' && !connectionTrigger.contains(event.target)) window.hajimink.dismissPageMenu();
}, true);
window.hajimink.onPageMenu(({ open, focus }) => {
  connectionTrigger.setAttribute('aria-expanded', String(open));
  if (focus === 'trigger') connectionTrigger.focus();
  else if (focus === 'next') {
    const next = ['#workspace-cli-action', '#authorize', '#reload'].map(id => $(id)).find(node => !node.disabled && !node.hidden && node.getClientRects().length);
    (next || connectionTrigger).focus();
  }
});
window.hajimink.onSelectConnection(async id => {
  if (state?.selected === id) return;
  try { state = await window.hajimink.select(id); render(); }
  catch (error) { showToast(formatError(error)); }
});
for (const button of document.querySelectorAll('[data-settings-section]')) button.addEventListener('click', () => void openSettings(button.dataset.settingsSection).catch(error => showToast(formatError(error))));
$('#help-content').innerHTML = window.HajiminkHelp;
function focusHelpSection(id) {
  const target = document.getElementById(id); if (!target) return;
  target.tabIndex = -1; target.scrollIntoView({ block: 'start' }); target.focus({ preventScroll: true });
}
for (const button of document.querySelectorAll('[data-open-help]')) button.addEventListener('click', async () => {
  try { await openSettings('documentation'); focusHelpSection(button.dataset.openHelp); }
  catch (error) { showToast(formatError(error)); }
});
$('#help-content').addEventListener('click', event => {
  const link = event.target.closest('a'); if (!link) return;
  if (link.dataset.helpProvider) { event.preventDefault(); void window.hajimink.providerGuide(link.dataset.helpProvider).catch(error => showToast(formatError(error))); }
  else if (link.getAttribute('href')?.startsWith('#')) { event.preventDefault(); focusHelpSection(link.getAttribute('href').slice(1)); }
});
$('#settings-back').addEventListener('click', () => void changePage('workspace').catch(error => showToast(formatError(error))));
$('#dock-brand').addEventListener('click', () => void changePage('workspace').catch(error => showToast(formatError(error))));
$('#dock-search').addEventListener('click', () => window.hajimink.workspaceSearch());
$('#shell-sidebar-open').addEventListener('click', () => window.hajimink.sidebarOpen(!sidebar.open));
$('#workspace-cli-action').addEventListener('click', () => { if (workspaceHeader?.kind === 'cli') window.hajimink.workspaceHeaderAction(workspaceHeader.action); });
for (const button of document.querySelectorAll('[data-go-settings]')) button.addEventListener('click', () => void openSettings('connections').catch(error => showToast(formatError(error))));
$('#fallback-settings').addEventListener('click', event => void openSettings(event.currentTarget.dataset.section || 'connections').catch(error => showToast(formatError(error))));
$('#fallback-retry').addEventListener('click', () => $('#reload').click());
for (const input of document.querySelectorAll('input[name="theme"]')) input.addEventListener('change', async () => {
  if (!input.checked) return;
  const feedback = $('#theme-feedback');
  for (const option of document.querySelectorAll('input[name="theme"]')) option.disabled = true;
  feedback.textContent = '正在应用主题…';
  try { state = await window.hajimink.setTheme(input.value); renderTheme(); feedback.textContent = '主题已应用到整个桌面窗口'; }
  catch (error) { renderTheme(); feedback.textContent = formatError(error); }
  finally { for (const option of document.querySelectorAll('input[name="theme"]')) option.disabled = false; }
});
$('#add').addEventListener('click', () => openDialog());
$('#cancel').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { clearProbe(); window.hajimink.modalVisible(false); });
$('#provider').addEventListener('change', () => { clearProbe(); updateProviderHint(); });
$('#provider-guide').addEventListener('click', async () => { try { await window.hajimink.providerGuide($('#provider').value); } catch (error) { $('#form-error').textContent = formatError(error); } });
$('#url').addEventListener('input', clearProbe);
$('#test-connection').addEventListener('click', async () => {
  const revision = ++probeRevision, button = $('#test-connection');
  button.disabled = true; $('#form-error').textContent = ''; $('#probe-status').textContent = '正在检查网关…';
  try {
    const result = await window.hajimink.probe({ url: $('#url').value });
    if (revision === probeRevision && dialog.open) $('#probe-status').textContent = result.message;
  } catch (error) {
    if (revision === probeRevision && dialog.open) $('#probe-status').textContent = formatError(error);
  } finally { if (revision === probeRevision) button.disabled = false; }
});
$('#connection-form').addEventListener('submit', async event => { event.preventDefault(); const data = { name: $('#name').value, url: $('#url').value, provider: $('#provider').value }; try { state = editing ? await window.hajimink.edit(editing, data) : await window.hajimink.add(data); dialog.close(); render(); if (!editing) await changePage('workspace'); } catch (error) { $('#form-error').textContent = formatError(error); } });
$('#reload').addEventListener('click', async () => { try { state = await window.hajimink.reload(); render(); } catch (error) { showToast(formatError(error)); } });
function showAuthorization(value) {
  if (!state || value.connectionId !== state.selected || !authorizationDialog.open) return;
  $('#authorization-message').textContent = value.message;
  const code = $('#authorization-code'); code.hidden = !value.userCode; code.textContent = value.userCode || '';
  $('#authorization-close').textContent = ['approved', 'denied', 'error', 'expired', 'canceled'].includes(value.state) ? '完成' : '取消';
}
$('#authorize').addEventListener('click', async () => {
  const selected = state.connections.find(item => item.id === state.selected); if (!selected) return;
  $('#authorization-address').textContent = `正在连接 ${selected.name} · ${selected.url}`;
  $('#authorization-code').hidden = true; $('#authorization-code').textContent = '';
  $('#authorization-message').textContent = '正在申请连接…'; $('#authorization-close').textContent = '取消';
  authorizationDialog.showModal();
  try { state = await window.hajimink.authorize(); showAuthorization(state.authorization); }
  catch (error) { $('#authorization-message').textContent = formatError(error); $('#authorization-close').textContent = '完成'; }
});
$('#authorization-close').addEventListener('click', async () => { try { state = await window.hajimink.cancelAuthorization(); } catch {} authorizationDialog.close(); });
authorizationDialog.addEventListener('cancel', () => { void window.hajimink.cancelAuthorization(); });
window.hajimink.onAuthorization(showAuthorization);
async function quitSoftware() {
  try { await window.hajimink.quit(); }
  catch (error) { showToast(formatError(error)); }
}
$('#settings-exit').addEventListener('click', () => void quitSoftware());
$('#gateway-toggle').addEventListener('change', async event => {
  const enabled = event.currentTarget.checked;
  if (gatewayBusy || !state?.gateway) return;
  if (!enabled) {
    const message = state.gateway.natapp?.managed ? '将先停止 HajiMink 启动的 NATAPP，再停止网关。连接到本机网关的 CLI 终端会结束，Codex 桌面会话的任务不会停止。继续吗？' : '停止 HajiMink 自己启动的本机网关？连接到本机网关的 CLI 终端会结束，Codex 桌面会话的任务不会停止。';
    if (!window.confirm(message)) { renderGateway(); return; }
  }
  gatewayBusy = true; renderGateway();
  try {
    state = await window.hajimink[enabled ? 'gatewayStart' : 'gatewayStop']();
    if (enabled) await finishLocalSetup();
  } catch (error) { showToast(formatError(error)); try { state = await window.hajimink.state(); } catch {} }
  finally { gatewayBusy = false; render(); }
});
$('#gateway-restart').addEventListener('click', () => {
  const managed = state?.gateway?.natapp?.managed;
  const message = managed ? '重启网关会结束连接到本机网关的 CLI 终端，并停止 HajiMink 启动的 NATAPP；重启后需要重新启动客户端。继续吗？' : '重启网关会结束连接到本机网关的 CLI 终端，Codex 桌面会话的任务不会停止。继续吗？';
  if ((state?.gateway?.state === 'ready' || managed) && !window.confirm(message)) return;
  void gatewayAction('gatewayRestart');
});
$('#gateway-keep-stopped').addEventListener('click', () => {
  if (window.confirm('记录网关保持手动停止？重新打开桌面时不会自动启动。')) void gatewayAction('gatewayStop');
});
$('#gateway-port-form').addEventListener('submit', async event => {
  event.preventDefault(); if (portSaving || !state?.gateway) return;
  const port = Number($('#gateway-port-input').value), feedback = $('#gateway-port-feedback');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { feedback.textContent = '请输入 1024 到 65535 之间的整数'; return; }
  if (port === state.gateway.port) { feedback.textContent = '端口没有变化'; return; }
  if (state.gateway.state === 'ready' && !window.confirm('更改端口需要重启本机网关，连接到本机网关的 CLI 终端和 HajiMink 管理的 NATAPP 会停止。Codex 桌面会话的任务不会停止；请同步更新隧道目标端口。继续吗？')) return;
  portSaving = true; feedback.textContent = '正在检查并保存端口…'; renderGateway();
  try { state = await window.hajimink.gatewaySetPort(port); feedback.textContent = state.gateway.state === 'ready' ? `已切换到端口 ${port}，网关已重新启动` : `已保存端口 ${port}，启动网关后生效`; }
  catch (error) { feedback.textContent = formatError(error); try { state = await window.hajimink.state(); } catch {} }
  finally { portSaving = false; render(); }
});
async function prepareWithoutAddress() {
  if ($('#gateway-no-address').disabled || ownerSaving) return;
  if (!window.confirm('请先关闭所有指向当前本机网关的隧道或端口映射。接下来网关会重启并锁定工作台；确认进入受限保护后，再启动隧道获取地址。继续吗？')) return;
  ownerSaving = true; const feedback = $('#gateway-owner-feedback'); feedback.textContent = '正在开启受限保护…'; renderGateway();
  try { state = await window.hajimink.gatewayPrepareAddress(); feedback.textContent = state.gateway.setupPending ? '受限保护已开启。请启动隧道，取得真实 HTTPS 地址后填写并生成设置码。' : '密码保护已开启。请启动隧道，取得真实 HTTPS 地址后填写并保存。'; showToast(feedback.textContent); }
  catch (error) { feedback.textContent = formatError(error); showToast(feedback.textContent); try { state = await window.hajimink.state(); } catch {} }
  finally { ownerSaving = false; render(); }
}
$('#gateway-no-address').addEventListener('click', () => void prepareWithoutAddress());
$('#gateway-auth-method').addEventListener('change', () => renderGateway());
$('#gateway-account').addEventListener('click', async () => {
  try { state = await window.hajimink.gatewayAccount(); await finishLocalSetup(); render(); await changePage('workspace'); }
  catch (error) { $('#gateway-owner-feedback').textContent = formatError(error); }
});
$('#gateway-owner-form').addEventListener('submit', async event => {
  event.preventDefault(); if (ownerSaving || $('#gateway-owner-enable').hidden) return;
  const changing = state?.gateway?.mode === 'owner';
  const submittedOrigin = $('#gateway-public-origin').value, submittedRevision = originDraftRevision;
  const question = changing ? '更改访问地址会短暂重启网关。请同步修改隧道；更换域名后可能需要重新添加通行密钥。继续吗？' : '请确认已经关闭所有指向本机网关的隧道或端口映射。接下来会启用独立登录并重启网关，之后再配置 HTTPS 和隧道。继续吗？';
  if (!window.confirm(question)) return;
  ownerSaving = true; const feedback = $('#gateway-owner-feedback'); feedback.textContent = changing ? '正在保存访问地址…' : '正在检查密码并启用独立登录…'; renderGateway();
  try { state = await window.hajimink.gatewayEnableOwner(submittedOrigin); reconcileOriginDraft(submittedRevision, true); feedback.textContent = originDraftDirty ? '先前提交的地址已保存；当前输入的地址尚未保存' : changing ? '访问地址已保存，请同步检查隧道和证书' : '独立登录已启用，请继续配置 HTTPS 和隧道'; showToast(feedback.textContent); }
  catch (error) { feedback.textContent = formatError(error); showToast(feedback.textContent); try { state = await window.hajimink.state(); } catch {} reconcileOriginDraft(submittedRevision, false); }
  finally { ownerSaving = false; render(); }
});
$('#gateway-passkey-start').addEventListener('click', async () => {
  if (ownerSaving || !state?.gateway || !$('#gateway-public-origin').reportValidity()) return;
  const pending = state.gateway.mode === 'owner' && state.gateway.setupPending;
  const submittedOrigin = $('#gateway-public-origin').value, submittedRevision = originDraftRevision;
  const question = state.gateway.awaitingPublicOrigin ? '将使用填写的真实 HTTPS 地址生成一次性设置码。继续吗？' : pending ? '重新生成会使旧设置码和未完成的设置失效。继续吗？' : '请确认已经关闭指向本机模式的隧道或端口映射。接下来网关将进入受限首次设置；请配置 HTTPS 和隧道后在最终域名完成注册。继续吗？';
  if (!window.confirm(question)) return;
  ownerSaving = true; const feedback = $('#gateway-owner-feedback'); clearSetupCode(); feedback.textContent = '正在准备受限首次设置…'; renderGateway();
  try {
    const result = pending ? await window.hajimink.gatewayBindPendingAddress(submittedOrigin) : await window.hajimink.gatewayPasskeySetup(submittedOrigin);
    state = result.state; reconcileOriginDraft(submittedRevision, true); render();
    const gateway = state.gateway;
    if (!gateway?.managed || gateway.state !== 'ready' || !gateway.setupPending || !gateway.publicOrigin || gateway.awaitingPublicOrigin || !gateway.pid || !gateway.controllerPid) throw new Error('未能确认设置码对应的网关，请检查状态后重新生成');
    setupCodeBinding = { origin: gateway.publicOrigin, pid: gateway.pid, controllerPid: gateway.controllerPid };
    $('#gateway-setup-code-origin').textContent = `设置码仅用于已保存地址：${gateway.publicOrigin}`;
    $('#gateway-setup-code').textContent = result.code;
    $('#gateway-setup-code-expiry').textContent = `有效期至 ${new Date(result.expiresAt).toLocaleTimeString()}，只能使用一次。`;
    $('#gateway-setup-code-panel').hidden = false;
    setupCodeTimer = setTimeout(() => { clearSetupCode(); feedback.textContent = '设置码已过期，请重新生成'; }, Math.max(0, result.expiresAt - Date.now()));
    feedback.textContent = originDraftDirty ? '设置码对应已保存地址；当前输入的地址尚未保存' : '请配置 HTTPS 和隧道，然后在最终地址输入设置码';
  } catch (error) { feedback.textContent = formatError(error); try { state = await window.hajimink.state(); } catch {} reconcileOriginDraft(submittedRevision, false); }
  finally { ownerSaving = false; render(); }
});
$('#gateway-open-setup').addEventListener('click', async () => {
  if (setupOpening || !setupCodeBinding) return;
  const feedback = $('#gateway-open-setup-feedback'), origin = setupCodeBinding.origin;
  setupOpening = true; feedback.textContent = '正在确认设置地址…'; renderGateway();
  try {
    const result = await window.hajimink.gatewayOpenSetup({ url: $('#gateway-public-origin').value });
    if (result.status === 'unavailable') { clearSetupCode(); $('#gateway-owner-feedback').textContent = '设置码已使用或过期，请在本机重新生成。'; }
    else if (result.status === 'opened') feedback.textContent = `已在浏览器打开 ${origin}，请核对地址并手动输入设置码。`;
    else feedback.textContent = '无法确认浏览器是否已打开，请重试。';
  } catch (error) { feedback.textContent = formatError(error); }
  finally { setupOpening = false; renderGateway(); }
});
$('#gateway-provider').addEventListener('change', async () => {
  const select = $('#gateway-provider');
  if (providerSaving) return;
  const value = select.value || null; const previous = state?.setup?.remoteDisabled ? 'off' : (state?.setup?.tunnelProvider || null);
  if (value === 'off') {
    providerSaving = true; select.disabled = true;
    try {
      const result = await window.hajimink.gatewayDisableRemote();
      state = result.state;
      select.value = result.canceled ? (previous || '') : 'off';
      if (!result.canceled) { clearSetupCode(); showToast('远程连接方式已关闭；其他转发由你自行管理'); }
    } catch (error) { select.value = previous || ''; showToast(formatError(error)); try { state = await window.hajimink.state(); } catch {} }
    finally { providerSaving = false; select.disabled = false; render(); }
    return;
  }
  publicProbeRevision++; $('#gateway-remote-test-feedback').textContent = '';
  $('#tunnel-draft-result').textContent = '';
  providerSaving = true; select.disabled = true;
  try { const saved = await window.hajimink.gatewayProvider(value); state.setup = saved.setup; state.tunnel = saved.tunnel; select.value = state.setup.tunnelProvider || ''; renderGateway(); }
  catch (error) { select.value = previous || ''; renderGateway(); showToast(formatError(error)); }
  finally { providerSaving = false; select.disabled = false; renderGateway(); }
});
async function natappOperation(method, value) {
  if (natappBusy) return;
  natappBusy = true; const feedback = $('#natapp-feedback'); feedback.textContent = '正在处理…'; renderGateway();
  try { state = await window.hajimink[method](value); feedback.textContent = method === 'natappSave' ? '文件位置已保存。配置内容仍由你保管。' : ''; }
  catch (error) { feedback.textContent = formatError(error); try { state = await window.hajimink.state(); } catch {} }
  finally { natappBusy = false; render(); }
}
$('#natapp-select-binary').addEventListener('click', () => void natappOperation('natappSelect', 'binary'));
$('#natapp-select-config').addEventListener('click', () => void natappOperation('natappSelect', 'config'));
$('#natapp-save').addEventListener('click', () => void natappOperation('natappSave'));
$('#natapp-start').addEventListener('click', () => {
  const port = state?.gateway?.port;
  if (!window.confirm(`请确认 NATAPP 隧道指向这台电脑的 127.0.0.1:${port}，并已准备 HTTPS。HajiMink 将运行你选择的 natapp.exe。继续吗？`)) return;
  void natappOperation('natappAction', 'start');
});
$('#natapp-stop').addEventListener('click', () => { if (window.confirm('停止 HajiMink 自己启动的 NATAPP 客户端？其他 NATAPP 进程不会被结束。')) void natappOperation('natappAction', 'stop'); });
$('#natapp-refresh').addEventListener('click', () => void natappOperation('natappAction', 'refresh'));
$('#gateway-public-origin').addEventListener('input', () => {
  originDraftDirty = true; originDraftRevision++; publicProbeRevision++;
  $('#gateway-remote-test-feedback').textContent = '';
  $('#tunnel-draft-result').textContent = '';
  $('#gateway-open-setup-feedback').textContent = '';
  if (!ownerSaving) $('#gateway-owner-feedback').textContent = '';
  renderGateway();
});
$('#gateway-origin-reset').addEventListener('click', () => {
  if ($('#gateway-origin-reset').hidden || $('#gateway-origin-reset').disabled) return;
  originDraftDirty = false; originDraftRevision++; publicProbeRevision++;
  $('#gateway-public-origin').value = state.gateway.publicOrigin;
  $('#gateway-remote-test-feedback').textContent = ''; $('#tunnel-draft-result').textContent = ''; renderGateway();
});
$('#gateway-remote-test').addEventListener('click', async () => {
  if (publicProbing || !state?.gateway) return;
  const revision = ++publicProbeRevision; const feedback = $('#gateway-remote-test-feedback');
  const requestedOrigin = $('#gateway-public-origin').value;
  publicProbing = true; feedback.textContent = '正在检查远程入口…'; renderGateway();
  try {
    const gateway = state.gateway;
    let sameOrigin = false;
    try { sameOrigin = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(requestedOrigin.trim()) ? requestedOrigin.trim() : `https://${requestedOrigin.trim()}`).origin === gateway.publicOrigin; } catch {}
    const confirmed = gateway.mode === 'owner' && gateway.state === 'ready' && gateway.managed && !gateway.awaitingPublicOrigin && sameOrigin;
    const result = await window.hajimink[confirmed ? 'gatewayPublicProbe' : 'gatewayProbeDraft']({ url: requestedOrigin });
    if (revision === publicProbeRevision) { feedback.textContent = result.message; $('#tunnel-draft-result').textContent = confirmed ? '' : `未保存地址检测：${result.message}`; }
  }
  catch (error) { if (revision === publicProbeRevision) feedback.textContent = formatError(error); }
  finally { publicProbing = false; renderGateway(); }
});
$('#logs-refresh').addEventListener('click', () => void loadLogs());
window.addEventListener('resize', layout);
window.addEventListener('keydown', event => {
  if (!event.isComposing && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault(); window.hajimink.sidebarOpen(!sidebar.open);
  }
});
window.hajimink.onSidebar(value => { sidebar = value; renderSidebar(); requestAnimationFrame(layout); });
window.hajimink.onWorkspaceHeader(value => { workspaceHeader = value; renderSidebar(); });
window.hajimink.onShowWorkspace(() => void changePage('workspace').catch(error => showToast(formatError(error))));
window.hajimink.onShowSettings(() => void openSettings().catch(error => showToast(formatError(error))));
window.hajimink.onTheme(value => { document.documentElement.dataset.theme = value.dark ? 'dark' : 'light'; if (!state) return; state.theme = value.theme; state.dark = value.dark; renderTheme(); });
window.hajimink.onExitState(value => { if (!state) return; state.exit = value; renderExitStatus(); renderGateway(); if (value.phase === 'failed') showToast(value.message); });
window.hajimink.onGateway(value => { if (!state) return; state.gateway = value; renderGateway(); renderWorkspaceFallback(); if (value.resumeError && value.resumeError !== lastResumeError) showToast(value.resumeError); lastResumeError = value.resumeError || ''; if (currentPage === 'settings' && settingsSection === 'logs') void loadLogs(); });
window.hajimink.onTunnel(value => { if (!state) return; state.tunnel = value; renderTunnelStatus(value); });
window.hajimink.onStatus(status);
window.hajimink.state().then(value => {
  state = value; sidebar = value.sidebar || sidebar; workspaceHeader = value.workspaceHeader || null;
  document.body.dataset.platform = state.platform;
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
  renderSidebar(); $('#gateway-provider').value = state.setup?.remoteDisabled ? 'off' : (state.setup?.tunnelProvider || ''); render();
  if (state.gateway?.resumeError) { lastResumeError = state.gateway.resumeError; showToast(lastResumeError); }
  if (!state.connections.length) void openSettings('connections').catch(error => showToast(formatError(error)));
  else if (state.setup?.complete === false && state.platform === 'win32') void openSettings('gateway').catch(error => showToast(formatError(error)));
  else { void changeSettingsSection(settingsSection); layout(); }
}).catch(error => showToast(formatError(error)));
