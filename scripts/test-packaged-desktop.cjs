'use strict';
const { selectDesktopPage, setGatewayEnabled } = require('./desktop-page-menu.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const { _electron: electron } = require('playwright');
const { waitForShellState } = require('./wait-shell-state.cjs');
const { ControllerGatewayManager } = require('../desktop/controller-manager.cjs');
const root = path.resolve(__dirname, '..');
const output = process.env.HAJIMINK_DESKTOP_BINARY || path.join(root, 'output', 'hajimink-desktop-build', 'win-unpacked', 'HajiMink.exe');
const requireReadOnly = process.argv.includes('--require-read-only');
const requireLimited = process.argv.includes('--require-limited');
let temp, application, page, origin, port, fakeServer, clean = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { freePort } = require('./test-network.cjs');
async function healthResponds() { try { return (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(700) })).ok; } catch { return false; } }
(async () => {
  if (!fs.existsSync(output)) throw new Error(`找不到已解包的桌面程序：${output}`);
  const archive = path.join(path.dirname(output), 'resources', 'app.asar');
  const packagedFiles = new Set(asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, '')));
  for (const name of ['providers.cjs', 'tunnel-status.cjs', 'natapp-manager.cjs']) assert.ok(packagedFiles.has(`desktop/${name}`), `missing desktop module: ${name}`);
  assert.equal(packagedFiles.has('desktop/tunnel-manager.cjs'), false, 'unintegrated tunnel prototype should not be packaged');
  const resourceRoot = path.join(path.dirname(output), 'resources', 'gateway');
  const runtime = path.join(resourceRoot, 'runtime', 'node.exe');
  assert.ok(fs.existsSync(path.join(resourceRoot, 'dist', 'index.html')));
  const frontendNotices = fs.readFileSync(path.join(resourceRoot, 'dist', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const name of ['react@', 'lucide-react@', '@xterm/xterm@', 'remark-gfm@']) assert.ok(frontendNotices.includes(name), `missing bundled license: ${name}`);
  assert.ok(fs.existsSync(path.join(resourceRoot, 'dist-server', 'index.js')));
  assert.ok(fs.existsSync(path.join(resourceRoot, 'node_modules', 'fastify', 'package.json')));
  assert.ok(fs.existsSync(path.join(resourceRoot, 'controller', 'PrivateControlPipe.exe')));
  assert.ok(fs.existsSync(path.join(resourceRoot, 'controller', 'gateway-controller.cjs')));
  const modules = path.join(resourceRoot, 'node_modules');
  const native = path.join(modules, 'node-pty', 'prebuilds', 'win32-x64');
  for (const file of ['conpty.node', 'conpty_console_list.node', 'pty.node', 'winpty-agent.exe', 'winpty.dll', 'conpty/OpenConsole.exe', 'conpty/conpty.dll']) {
    assert.ok(fs.existsSync(path.join(native, file)), `missing x64 terminal resource: ${file}`);
  }
  for (const file of ['conpty.pdb', 'pty.pdb']) assert.equal(fs.existsSync(path.join(native, file)), false, `unexpected debug file: ${file}`);
  assert.equal(fs.existsSync(path.join(modules, 'node-pty', 'prebuilds', 'win32-arm64')), false);
  for (const name of ['lucide-react', 'react-dom', 'react-markdown', 'remark-gfm', '@xterm']) assert.equal(fs.existsSync(path.join(modules, name)), false, `unexpected browser-only package: ${name}`);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(runtime)).digest('hex'), '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237');
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-packaged-test-'));
  port = await freePort(); origin = `http://127.0.0.1:${port}`;
  // Remove PATH for this child so a system Node installation cannot be used accidentally.
  application = await electron.launch({ executablePath: output, args: [`--hajimink-data-dir=${temp}`, `--hajimink-gateway-port=${port}`], cwd: root, env: { ...process.env, PATH: '' }, timeout: 60000 });
  page = await application.firstWindow({ timeout: 20000 });
  await selectDesktopPage(page, 'gateway');
  await page.locator('#gateway-toggle').waitFor({ state: 'attached' });
  assert.equal(await healthResponds(), false, 'fresh setup should wait for the user before starting a gateway');
  await setGatewayEnabled(page, true);
  await page.waitForFunction(() => ['正常', '故障'].includes(document.querySelector('#gateway-state-badge')?.textContent), null, { timeout: 45000 });
  const badge = await page.locator('#gateway-state-badge').textContent();
  assert.equal(badge, '正常', `packaged gateway failed: ${await page.locator('#gateway-state-message').textContent()}`);
  const state = await page.evaluate(() => window.hajimink.state());
  assert.equal(state.gateway.managed, true); assert.equal(state.gateway.mode, 'local');
  const health = await fetch(`${origin}/api/health`); assert.equal(health.status, 200); const healthData = await health.json(); assert.equal(healthData.mode, 'local');
  if (requireReadOnly) assert.ok(healthData.desktop.connected && healthData.desktop.accessMode === 'read-only' && !healthData.desktop.compatible, `packaged gateway did not connect in read-only mode: ${healthData.desktop.reason || 'unknown'}`);
  if (requireLimited) assert.ok(healthData.desktop.connected && healthData.desktop.accessMode === 'limited' && healthData.desktop.compatible, `packaged gateway did not connect in limited mode: ${healthData.desktop.reason || 'unknown'}`);
  await waitForShellState(page, value => !!value.gateway?.desktop);
  if (requireReadOnly) {
    await page.waitForFunction(() => document.querySelector('#desktop-state-badge')?.textContent === '仅查看', null, { timeout: 15000 });
    assert.equal(await page.locator('#desktop-state-version').textContent(), healthData.desktop.version);
    assert.match(await page.locator('#desktop-state-detail').textContent(), /尚未验证/);
  }
  if (requireLimited) {
    await page.waitForFunction(() => document.querySelector('#desktop-state-badge')?.textContent === '部分可用', null, { timeout: 15000 });
    assert.equal(await page.locator('#desktop-state-version').textContent(), healthData.desktop.version);
    assert.match(await page.locator('#desktop-state-detail').textContent(), /审批请在 Codex/);
  }
  const home = await (await fetch(origin)).text(); assert.match(home, /assets\/index-/);
  assert.equal(await page.locator('#connection-select span').textContent(), '本机 · 本机');
  await selectDesktopPage(page, 'workspace');
  let workbench;
  for (let i = 0; i < 100; i++) {
    workbench = await application.evaluate(async ({ webContents }, origin) => {
      const target = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().startsWith(origin));
      return target ? target.executeJavaScript('!!document.querySelector(".workspace")') : false;
    }, origin).catch(() => false);
    if (workbench) break; await delay(100);
  }
  assert.equal(workbench, true, 'packaged React workbench must render');
  const composer = await application.evaluate(async ({ webContents }, origin) => {
    const target = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().startsWith(origin));
    return target?.executeJavaScript(`(() => {
      const form = document.querySelector('.composer');
      const input = form?.querySelector('textarea');
      return form && input ? { height: form.getBoundingClientRect().height, value: input.value } : null;
    })()`);
  }, origin);
  assert.ok(composer && composer.value === '' && composer.height <= 96, `packaged workbench should use the compact composer: ${JSON.stringify(composer)}`);
  if (requireReadOnly) {
    let readOnly = false;
    for (let i = 0; i < 100; i++) {
      readOnly = await application.evaluate(async ({ webContents }, origin) => {
        const target = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().startsWith(origin));
        return target && target.executeJavaScript(`!!document.querySelector('.sidebar-footer strong')?.textContent?.includes('只读') && !!document.querySelector('.connection-banner')?.textContent?.includes('仅支持查看') && document.querySelector('.new-thread')?.disabled && document.querySelector('.send-button')?.disabled && document.querySelectorAll('.thread-row').length > 0`);
      }, origin).catch(() => false);
      if (readOnly) break; await delay(200);
    }
    assert.equal(readOnly, true, 'packaged UI must render the real catalog and disable writes');
  }
  if (requireLimited) {
    let limited = false;
    for (let i = 0; i < 100; i++) {
      limited = await application.evaluate(async ({ webContents }, origin) => {
        const target = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().startsWith(origin));
        return target && target.executeJavaScript(`!!document.querySelector('.sidebar-footer strong')?.textContent?.includes('部分可用') && !!document.querySelector('.connection-banner')?.textContent?.includes('项目内新建') && !document.querySelector('.new-thread')?.disabled && document.querySelector('.send-button')?.disabled && document.querySelectorAll('.thread-row').length > 0`);
      }, origin).catch(() => false);
      if (limited) break; await delay(200);
    }
    assert.equal(limited, true, 'packaged UI must show the real catalog and limited compatibility guidance');
  }
  await selectDesktopPage(page, 'gateway'); page.once('dialog', dialog => dialog.accept()); await setGatewayEnabled(page, false);
  await page.waitForFunction(() => document.querySelector('#gateway-state-badge')?.textContent === '未启动', null, { timeout: 15000 });
  assert.equal(await healthResponds(), false);
  assert.equal(fs.existsSync(path.join(temp, 'gateway', 'gateway.stdout.log')), false);
  assert.equal(fs.existsSync(path.join(temp, 'gateway', 'gateway.stderr.log')), false);
  fakeServer = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"mode":"local"}'); });
  await new Promise(resolve => fakeServer.listen(port, '127.0.0.1', resolve));
  await setGatewayEnabled(page, true);
  await page.waitForFunction(() => document.querySelector('#gateway-state-badge')?.textContent === '故障', null, { timeout: 10000 });
  assert.match(await page.locator('#gateway-state-message').textContent(), /端口.*已被占用/);
  assert.equal((await (await fetch(`${origin}/api/health`)).json()).ok, true, 'the foreign listener must remain alive');
  assert.equal(await page.locator('#gateway-toggle').isChecked(), false);
  const unknownLoaded = await application.evaluate(({ webContents }, origin) => webContents.getAllWebContents().some(w => !w.isDestroyed() && w.getURL().startsWith(origin)), origin);
  assert.equal(unknownLoaded, false, 'the default local view must not connect to an unverified listener');
  await new Promise(resolve => fakeServer.close(resolve)); fakeServer = undefined;
  await setGatewayEnabled(page, true);
  await page.waitForFunction(() => document.querySelector('#gateway-state-badge')?.textContent === '正常', null, { timeout: 30000 });
  page.once('dialog', dialog => dialog.accept()); await setGatewayEnabled(page, false);
  await page.waitForFunction(() => ['未启动', '故障'].includes(document.querySelector('#gateway-state-badge')?.textContent), null, { timeout: 25000 });
  assert.equal(await page.locator('#gateway-state-badge').textContent(), '未启动', `second stop failed: ${await page.locator('#gateway-state-message').textContent()}`);
  assert.equal(await healthResponds(), false);
  console.log(JSON.stringify({ packagedShell: 'passed', physicalNode24AndProductionDependencies: 'passed', emptyPathStartup: 'passed', bundledWorkbench: 'passed', compactComposer: 'passed', managedGatewayAndRestart: 'passed', foreignFakeGatewayNotAdopted: 'passed', rawLogs: 'not written', realCodexReadOnly: requireReadOnly ? 'passed' : 'not checked', realCodexLimited: requireLimited ? 'passed' : 'not checked', port }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (page) {
    try { await Promise.race([page.evaluate(() => window.hajimink.gatewayStop()), delay(6000)]); } catch {}
  }
  if (application) {
    try { await Promise.race([application.close(), delay(8000).then(() => { throw new Error('桌面测试进程退出超时'); })]); } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
  if (fakeServer) { fakeServer.closeAllConnections(); await new Promise(resolve => fakeServer.close(resolve)); }
  if (temp && port && fs.existsSync(path.join(temp, 'gateway', 'controller.instance.json'))) {
    const appRoot = path.join(path.dirname(output), 'resources', 'gateway');
    const cleanup = new ControllerGatewayManager({ appRoot, dataDir: path.join(temp, 'gateway'), port, nodePath: path.join(appRoot, 'runtime', 'node.exe'), runAsNode: false, startTimeoutMs: 15000 });
    try { await cleanup.stop(); } catch {} cleanup.close();
  }
  clean = !origin || !(await healthResponds());
  if (temp && clean) {
    const resolved = fs.realpathSync(temp), safeRoot = fs.realpathSync(os.tmpdir());
    if (!resolved.startsWith(safeRoot + path.sep) || !path.basename(resolved).startsWith('hajimink-packaged-test-')) throw new Error('Unexpected test directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  } else if (temp) { console.error(`测试网关仍在运行，已保留临时数据供排查：${temp}`); process.exitCode = 1; }
});
