import { randomBytes, timingSafeEqual } from 'node:crypto';

// A ticket grants exactly one diagnostic upgrade, never a business session.
// Nothing is persisted, and one outstanding ticket/socket bounds resource use.
export class StreamDiagnostic {
  private ticket: { token: string; expiresAt: number } | undefined;
  private active = false;
  constructor(private now = Date.now) {}
  issue() {
    if (this.active) throw new Error('diagnostic busy');
    this.ticket = { token: randomBytes(32).toString('base64url'), expiresAt: this.now() + 20000 };
    return { ...this.ticket };
  }
  claim(value: unknown): (() => void) | undefined {
    const ticket = this.ticket;
    if (this.active || !ticket || ticket.expiresAt <= this.now() || typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return;
    const actual = Buffer.from(value, 'utf8'), expected = Buffer.from(ticket.token, 'utf8');
    if (!timingSafeEqual(actual, expected)) return;
    this.ticket = undefined; this.active = true;
    let released = false;
    return () => { if (!released) { released = true; this.active = false; } };
  }
  clear() { this.ticket = undefined; }
}
