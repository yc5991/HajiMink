'use strict';
// Poll resolved shell state in Node: an async page.waitForFunction predicate
// returns a truthy Promise before its boolean result is known.
async function waitForShellState(page, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
  const intervalMs = options.intervalMs ?? 100;
  if (typeof predicate !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Invalid shell state wait');
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await page.evaluate(() => window.hajimink.state());
    const matched = predicate(state);
    if (typeof matched !== 'boolean') throw new Error('Shell state predicate must return a boolean');
    if (matched) return state;
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for the expected isolated desktop state');
}
module.exports = { waitForShellState };
