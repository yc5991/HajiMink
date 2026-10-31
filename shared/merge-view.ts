import type { ThreadView } from './types';
// Incoming snapshots own the newest window, including replacement of optimistic turn IDs.
export function mergeView(previous: ThreadView | null, next: ThreadView): ThreadView {
  if (previous?.id === next.id && previous.epoch) {
    if (next.epoch === previous.epoch && next.revision < previous.revision) return previous;
    if (!next.epoch && !next.live) return previous; // A slower saved-history read cannot replace a live stream.
    if (next.epoch && next.epoch !== previous.epoch) return next; // A new desktop owner starts a new revision sequence.
  }
  if (!previous || previous.id !== next.id || next.totalTurns < previous.totalTurns || !next.olderCursor) return next;
  const boundary = next.turns[0]?.startedAt || 0;
  const ids = new Set(next.turns.map(t => t.id));
  const older = previous.turns.filter(t => !ids.has(t.id) && !t.id.startsWith('turn-') && t.startedAt < boundary);
  return { ...next, turns: [...older, ...next.turns], olderCursor: older.length ? previous.olderCursor : next.olderCursor };
}
