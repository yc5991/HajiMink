import { expect, it, vi } from 'vitest';
// @ts-expect-error Test helpers are intentionally shared with CommonJS scripts.
import { waitForShellState } from '../scripts/wait-shell-state.cjs';

it('waits until a resolved state actually matches instead of accepting an async predicate promise', async () => {
  const evaluate = vi.fn().mockResolvedValueOnce({ ready: false }).mockResolvedValueOnce({ ready: false }).mockResolvedValueOnce({ ready: true });
  const state = await waitForShellState({ evaluate }, (value: any) => value.ready === true, { timeoutMs: 100, intervalMs: 1 });
  expect(state).toEqual({ ready: true });
  expect(evaluate).toHaveBeenCalledTimes(3);
});

it('fails on a timeout or non-boolean predicate rather than reporting a false pass', async () => {
  const page = { evaluate: vi.fn().mockResolvedValue({ ready: false }) };
  await expect(waitForShellState(page, (value: any) => value.ready, { timeoutMs: 10, intervalMs: 1 })).rejects.toThrow(/Timed out/);
  await expect(waitForShellState(page, async () => false, { timeoutMs: 10, intervalMs: 1 })).rejects.toThrow(/boolean/);
});
