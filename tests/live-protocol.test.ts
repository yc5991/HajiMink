import { expect, it } from 'vitest';
import { isDesktopGreeting } from '../src/live-protocol';

it('accepts only a desktop status greeting for the selected adapter', () => {
  const desktop = { connected: true, compatible: false, version: 'test' };
  expect(isDesktopGreeting({ type: 'desktop', harness: 'codex', desktop }, 'codex')).toBe(true);
  expect(isDesktopGreeting({ type: 'desktop', desktop }, 'codex')).toBe(true);
  expect(isDesktopGreeting({ type: 'desktop', desktop }, 'other')).toBe(false);
  for (const value of [null, [], {}, { type: 'thread', harness: 'codex', desktop }, { type: 'desktop', harness: 'other', desktop }, { type: 'desktop', harness: 'codex', desktop: {} }, { type: 'desktop', harness: 'codex', desktop: { connected: 'yes', compatible: true } }])
    expect(isDesktopGreeting(value, 'codex')).toBe(false);
});
