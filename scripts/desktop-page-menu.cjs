'use strict';

async function openDesktopMenu(page, trigger) {
  await page.locator(trigger).click();
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const menu = page.context().pages().find(item => !item.isClosed() && item.url().startsWith('hajimink://app/page-menu.html?'));
    if (menu) { await menu.locator('[role="menu"]').waitFor(); return menu; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('页面切换菜单未打开');
}

async function openDesktopConnectionMenu(page) { return openDesktopMenu(page, '#connection-select'); }

async function selectDesktopPage(page, value) {
  if (value === 'workspace') {
    await page.evaluate(() => document.querySelector('#dock-brand').click());
    await page.waitForFunction(() => document.body.dataset.page === 'workspace');
    return;
  }
  const section = value === 'settings' ? 'connections' : value;
  if (await page.evaluate(() => document.body.dataset.page !== 'settings')) await page.evaluate(() => document.querySelector('#fallback-settings').click());
  await page.waitForFunction(() => document.body.dataset.page === 'settings');
  await page.locator(`[data-settings-section="${section}"]`).click();
  await page.locator(`[data-settings-section="${section}"][aria-current="page"]`).waitFor();
}

async function selectDesktopConnection(page, id) {
  const menu = await openDesktopConnectionMenu(page);
  await menu.locator(`[role="menuitemradio"][data-connection="${id}"]`).click();
  await page.waitForFunction(value => document.querySelector('#connection-select')?.dataset.selected === value, id);
}

async function setGatewayEnabled(page, enabled) {
  if (await page.locator('#gateway-toggle').isChecked() !== enabled) await page.locator('.gateway-switch').click();
}

module.exports = { openDesktopConnectionMenu, selectDesktopPage, selectDesktopConnection, setGatewayEnabled };
