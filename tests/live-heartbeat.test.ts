import { afterEach, expect, it, vi } from 'vitest';
import { LiveHeartbeat, supportsLiveHeartbeat } from '../src/live-heartbeat';
import { LIVE_HEARTBEAT_INTERVAL_MS, LIVE_HEARTBEAT_PROTOCOL, LIVE_HEARTBEAT_TIMEOUT_MS } from '../shared/live-heartbeat';

const first = 'a'.repeat(32), second = 'b'.repeat(32);
afterEach(() => vi.useRealTimers());

it('uses only the explicitly advertised heartbeat protocol', () => {
  expect(supportsLiveHeartbeat({ heartbeat: LIVE_HEARTBEAT_PROTOCOL })).toBe(true);
  for (const value of [null, [], {}, { heartbeat: 'other' }, { heartbeat: 1 }]) expect(supportsLiveHeartbeat(value)).toBe(false);
});

it('requires the matching round trip before going online and detects a silent break', () => {
  vi.useFakeTimers();
  const send = vi.fn(), healthy = vi.fn(), fail = vi.fn();
  const monitor = new LiveHeartbeat({ send, onHealthy: healthy, onFailure: fail, nonce: () => first });
  monitor.start(); monitor.start(); expect(send).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledWith(first);
  expect(monitor.receive({ type: 'heartbeat-pong', nonce: second })).toBe(false);
  vi.advanceTimersByTime(LIVE_HEARTBEAT_TIMEOUT_MS - 1); expect(healthy).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(fail).toHaveBeenCalledOnce();
  expect(monitor.receive({ type: 'heartbeat-pong', nonce: first })).toBe(false);
  vi.advanceTimersByTime(60_000); expect(send).toHaveBeenCalledOnce(); expect(fail).toHaveBeenCalledOnce();
});

it('only accepts the currently outstanding nonce and schedules the next check', () => {
  vi.useFakeTimers();
  const send = vi.fn(), healthy = vi.fn(), fail = vi.fn(), nonce = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const monitor = new LiveHeartbeat({ send, onHealthy: healthy, onFailure: fail, nonce });
  monitor.start(); expect(monitor.receive({ type: 'heartbeat-pong', nonce: first })).toBe(true); expect(healthy).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(LIVE_HEARTBEAT_INTERVAL_MS); expect(send).toHaveBeenCalledTimes(2); expect(send).toHaveBeenLastCalledWith(second);
  expect(monitor.receive({ type: 'heartbeat-pong', nonce: first })).toBe(false);
  expect(monitor.receive({ type: 'heartbeat-pong', nonce: second })).toBe(true); expect(healthy).toHaveBeenCalledTimes(2);
  monitor.stop(); vi.advanceTimersByTime(60_000); expect(send).toHaveBeenCalledTimes(2); expect(fail).not.toHaveBeenCalled();
});

it('fails closed if nonce creation, socket send, or online transition fails', () => {
  vi.useFakeTimers();
  for (const overrides of [
    { nonce: () => 'invalid' },
    { nonce: () => { throw new Error('unavailable'); } },
    { nonce: () => first, send: () => { throw new Error('closed'); } },
    { nonce: () => first, onHealthy: () => { throw new Error('closed'); } }
  ]) {
    const fail = vi.fn(), send = vi.fn();
    const monitor = new LiveHeartbeat({ send, onHealthy: () => {}, onFailure: fail, ...overrides });
    monitor.start(); monitor.receive({ type: 'heartbeat-pong', nonce: first });
    expect(fail).toHaveBeenCalledOnce(); monitor.stop(); vi.advanceTimersByTime(60_000); expect(fail).toHaveBeenCalledOnce();
  }
});

it('stops pending timers without reporting a failure', () => {
  vi.useFakeTimers();
  const fail = vi.fn(), send = vi.fn();
  const monitor = new LiveHeartbeat({ send, onHealthy: () => {}, onFailure: fail, nonce: () => first });
  monitor.start(); monitor.stop(); expect(monitor.receive({ type: 'heartbeat-pong', nonce: first })).toBe(false);
  vi.advanceTimersByTime(60_000); expect(fail).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledOnce();
});
