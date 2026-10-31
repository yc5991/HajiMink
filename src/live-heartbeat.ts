import { LIVE_HEARTBEAT_INTERVAL_MS, LIVE_HEARTBEAT_NONCE, LIVE_HEARTBEAT_PROTOCOL, LIVE_HEARTBEAT_TIMEOUT_MS } from '../shared/live-heartbeat';

export function supportsLiveHeartbeat(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).heartbeat === LIVE_HEARTBEAT_PROTOCOL;
}

/** A single outstanding, nonce-bound round trip. Stopping it never retries work. */
export class LiveHeartbeat {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: string | null = null;
  private stopped = true;
  constructor(private readonly options: {
    send: (nonce: string) => void;
    onHealthy: () => void;
    onFailure: () => void;
    nonce?: () => string;
    intervalMs?: number;
    timeoutMs?: number;
  }) {}
  start() { if (!this.stopped) return; this.stopped = false; this.ping(); }
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; this.pending = null; }
  receive(value: unknown): boolean {
    if (this.stopped || !this.pending || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const message = value as Record<string, unknown>;
    if (message.type !== 'heartbeat-pong' || message.nonce !== this.pending) return false;
    clearTimeout(this.timer); this.timer = undefined; this.pending = null;
    try { this.options.onHealthy(); } catch { this.fail(); return false; }
    if (!this.stopped) this.timer = setTimeout(() => this.ping(), this.options.intervalMs ?? LIVE_HEARTBEAT_INTERVAL_MS);
    return true;
  }
  private ping() {
    if (this.stopped) return;
    try {
      const nonce = this.options.nonce ? this.options.nonce() : crypto.randomUUID().replaceAll('-', '');
      if (!LIVE_HEARTBEAT_NONCE.test(nonce)) throw new Error('Invalid heartbeat nonce');
      this.pending = nonce;
      this.timer = setTimeout(() => this.fail(), this.options.timeoutMs ?? LIVE_HEARTBEAT_TIMEOUT_MS);
      this.options.send(nonce);
    } catch { this.fail(); }
  }
  private fail() { if (this.stopped) return; this.stop(); this.options.onFailure(); }
}
