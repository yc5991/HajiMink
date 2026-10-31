import { it, expect } from 'vitest';
import { mergeView } from '../shared/merge-view';
import type { ThreadView } from '../shared/types';
const view = (ids: string[], cursor: string | null = null) => ({ id: 't', totalTurns: ids.length, olderCursor: cursor, turns: ids.map((id, i) => ({ id, startedAt: i, status: 'completed', items: [] })) } as unknown as ThreadView);
it('replaces optimistic turns instead of leaving duplicate working indicators', () => {
  const previous = view(['real-1', 'turn-1']); const incoming = view(['real-1', 'real-2']);
  expect(mergeView(previous, incoming).turns.map(t => t.id)).toEqual(['real-1', 'real-2']);
});
it('preserves explicitly loaded older history when the newest page updates', () => {
  const previous = view(['a', 'b', 'c', 'd']); const incoming = view(['c', 'd'], 'c'); incoming.totalTurns = 4; incoming.turns[0].startedAt = 2; incoming.turns[1].startedAt = 3;
  expect(mergeView(previous, incoming).turns.map(t => t.id)).toEqual(['a', 'b', 'c', 'd']);
  expect(mergeView(previous, incoming).olderCursor).toBeNull();
});
it('ignores delayed snapshots in the same stream and accepts lower revisions from a new owner', () => {
  const current = { ...view(['a', 'b']), epoch: 'owner-a', revision: 9, live: true };
  expect(mergeView(current, { ...current, revision: 8, turns: [] })).toBe(current);
  expect(mergeView(current, { ...current, epoch: undefined, live: false, turns: [] })).toBe(current);
  const restarted = { ...current, epoch: 'owner-b', revision: 1, turns: [] };
  expect(mergeView(current, restarted)).toBe(restarted);
});
