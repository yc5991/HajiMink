import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const codePattern = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lifetime = 5 * 60 * 1000;
const interval = 2 * 1000;
const maximumDevices = 30;
const maximumRequests = 100;
type RequestRow = { request_hash: string; user_code_hash: string; device_name: string; state: string; created_at: number; expires_at: number; last_poll_at: number | null; remember: number; approval_hash: string | null; approval_expires_at: number | null };
type DeviceRow = { id: string; token_hash: string; device_name: string; created_at: number; expires_at: number };
export interface DeviceSession { id: string; hash: string; createdAt: number; expiresAt: number; }

/** Owner-authorized desktop grants. Only digests of bearer material are persisted. */
export class DeviceAuth extends EventEmitter {
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(readonly db: DatabaseSync, private now = () => Date.now()) {
    super();
    db.exec(`CREATE TABLE IF NOT EXISTS device_requests(
      request_hash TEXT PRIMARY KEY, user_code_hash TEXT NOT NULL UNIQUE,
      device_name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','approved','denied')),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_poll_at INTEGER,
      remember INTEGER NOT NULL DEFAULT 0, approval_hash TEXT UNIQUE, approval_expires_at INTEGER);
      CREATE INDEX IF NOT EXISTS device_requests_expiry ON device_requests(expires_at);
      CREATE TABLE IF NOT EXISTS device_grants(
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, device_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS device_grants_expiry ON device_grants(expires_at);`);
  }
  private prune() {
    const now = this.now();
    this.db.prepare('DELETE FROM device_requests WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM device_grants WHERE expires_at<=?').run(now);
    for (const [key, entry] of this.attempts) if (entry.until <= now) this.attempts.delete(key);
  }
  private limit(key: string, max: number) {
    this.prune(); const now = this.now(); const id = hash(key);
    const entry = this.attempts.get(id) || { count: 0, until: now + 15 * 60 * 1000 };
    if (entry.count >= max || this.attempts.size >= 4000) throw new AppError('DEVICE_RATE_LIMIT', '操作过于频繁，请稍后再试', 429);
    entry.count++; this.attempts.set(id, entry);
  }
  private validName(name: string) {
    if (typeof name !== 'string') throw new AppError('DEVICE_NAME_INVALID', '请输入设备名称', 400);
    const value = name.trim();
    if (!value || value.length > 60 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new AppError('DEVICE_NAME_INVALID', '设备名称应为 1 至 60 个可显示字符', 400);
    return value;
  }
  private normalizeCode(code: string) {
    if (typeof code !== 'string' || code.length > 20) throw new AppError('DEVICE_CODE_INVALID', '确认码无效或已过期，请重新申请', 404);
    const value = code.toUpperCase().replace(/[ -]/g, '');
    if (!codePattern.test(value)) throw new AppError('DEVICE_CODE_INVALID', '确认码无效或已过期，请重新申请', 404);
    return value;
  }
  create(name: string, client: string) {
    const deviceName = this.validName(name);
    this.limit(`create:${client}`, 20); this.limit('create-total', 100);
    if (Number((this.db.prepare('SELECT COUNT(*) AS count FROM device_requests').get() as any).count) >= maximumRequests) throw new AppError('DEVICE_REQUEST_LIMIT', '待处理的设备请求已达上限，请稍后再试', 429);
    const requestId = secret(); let userCode = '';
    for (let attempt = 0; attempt < 16; attempt++) {
      const bytes = randomBytes(8); const candidate = Array.from(bytes, value => alphabet[value & 31]).join('');
      if (!this.db.prepare('SELECT 1 FROM device_requests WHERE user_code_hash=?').get(hash(candidate))) { userCode = candidate; break; }
    }
    if (!userCode) throw new AppError('DEVICE_BUSY', '暂时无法创建连接请求，请重试', 503);
    const now = this.now();
    this.db.prepare("INSERT INTO device_requests(request_hash,user_code_hash,device_name,state,created_at,expires_at,remember) VALUES(?,?,?,'pending',?,?,0)").run(hash(requestId), hash(userCode), deviceName, now, now + lifetime);
    return { requestId, userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}`, expiresAt: now + lifetime, intervalSeconds: interval / 1000 };
  }
  status(requestId: string) {
    if (!tokenPattern.test(requestId)) throw new AppError('DEVICE_REQUEST_EXPIRED', '连接请求已失效，请重新申请', 410);
    const row = this.db.prepare('SELECT * FROM device_requests WHERE request_hash=? AND expires_at>?').get(hash(requestId), this.now()) as RequestRow | undefined;
    if (!row) throw new AppError('DEVICE_REQUEST_EXPIRED', '连接请求已失效，请重新申请', 410);
    if (row.last_poll_at !== null && this.now() - row.last_poll_at < interval) throw new AppError('DEVICE_POLL_SLOW', '查询过于频繁，请稍后重试', 429);
    this.db.prepare('UPDATE device_requests SET last_poll_at=? WHERE request_hash=?').run(this.now(), row.request_hash);
    return { state: row.state, expiresAt: row.expires_at, intervalSeconds: interval / 1000 };
  }
  lookup(code: string, client: string) {
    this.limit(`lookup:${client}`, 20); this.limit('lookup-total', 200);
    const normalized = this.normalizeCode(code); const now = this.now();
    const row = this.db.prepare("SELECT * FROM device_requests WHERE user_code_hash=? AND state='pending' AND expires_at>?").get(hash(normalized), now) as RequestRow | undefined;
    if (!row) throw new AppError('DEVICE_CODE_INVALID', '确认码无效或已过期，请重新申请', 404);
    const approvalTicket = secret();
    this.db.prepare("UPDATE device_requests SET approval_hash=?,approval_expires_at=? WHERE request_hash=? AND state='pending'").run(hash(approvalTicket), Math.min(row.expires_at, now + 2 * 60 * 1000), row.request_hash);
    return { approvalTicket, userCode: `${normalized.slice(0, 4)}-${normalized.slice(4)}`, deviceName: row.device_name, expiresAt: row.expires_at };
  }
  decide(approvalTicket: string, approve: boolean, remember = false) {
    if (!tokenPattern.test(approvalTicket)) throw new AppError('DEVICE_APPROVAL_EXPIRED', '授权页面已过期，请重新输入确认码', 409);
    const row = this.db.prepare("UPDATE device_requests SET state=?,remember=?,approval_hash=NULL,approval_expires_at=NULL WHERE approval_hash=? AND state='pending' AND expires_at>? AND approval_expires_at>? RETURNING request_hash").get(approve ? 'approved' : 'denied', remember ? 1 : 0, hash(approvalTicket), this.now(), this.now()) as { request_hash: string } | undefined;
    if (!row) throw new AppError('DEVICE_APPROVAL_EXPIRED', '授权页面已过期，请重新输入确认码', 409);
    return { ok: true };
  }
  cancel(requestId: string) {
    if (tokenPattern.test(requestId)) this.db.prepare('DELETE FROM device_requests WHERE request_hash=?').run(hash(requestId));
    return { ok: true };
  }
  exchange(requestId: string) {
    if (!tokenPattern.test(requestId)) throw new AppError('DEVICE_EXCHANGE_FAILED', '连接请求尚未授权或已失效', 409);
    const token = secret(); const id = randomUUID(); const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("DELETE FROM device_requests WHERE request_hash=? AND state='approved' AND expires_at>? RETURNING device_name,remember").get(hash(requestId), now) as { device_name: string; remember: number } | undefined;
      if (!row) throw new AppError('DEVICE_EXCHANGE_FAILED', '连接请求尚未授权或已失效', 409);
      this.db.prepare('DELETE FROM device_grants WHERE expires_at<=?').run(now);
      if (Number((this.db.prepare('SELECT COUNT(*) AS count FROM device_grants').get() as any).count) >= maximumDevices) throw new AppError('DEVICE_LIMIT', '已授权设备数量达到上限', 409);
      const expiresAt = now + (row.remember ? 7 * 24 : 8) * 60 * 60 * 1000;
      this.db.prepare('INSERT INTO device_grants(id,token_hash,device_name,created_at,expires_at) VALUES(?,?,?,?,?)').run(id, hash(token), row.device_name, now, expiresAt);
      this.db.exec('COMMIT'); return { token, deviceId: id, expiresAt };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  session(token?: string): DeviceSession | undefined {
    if (!token || !tokenPattern.test(token)) return;
    const row = this.db.prepare('SELECT * FROM device_grants WHERE token_hash=? AND expires_at>?').get(hash(token), this.now()) as DeviceRow | undefined;
    return row ? { id: row.id, hash: row.token_hash, createdAt: row.created_at, expiresAt: row.expires_at } : undefined;
  }
  validSessionHash(tokenHash: string) { return !!this.db.prepare('SELECT 1 FROM device_grants WHERE token_hash=? AND expires_at>?').get(tokenHash, this.now()); }
  list() {
    this.prune();
    return (this.db.prepare('SELECT id,device_name,created_at,expires_at FROM device_grants ORDER BY created_at DESC,id').all() as Array<Omit<DeviceRow, 'token_hash'>>).map(row => ({ id: row.id, name: row.device_name, createdAt: row.created_at, expiresAt: row.expires_at }));
  }
  revoke(id: string) {
    if (!uuidPattern.test(id)) throw new AppError('DEVICE_NOT_FOUND', '授权设备不存在', 404);
    const row = this.db.prepare('DELETE FROM device_grants WHERE id=? RETURNING token_hash').get(id) as { token_hash: string } | undefined;
    if (!row) throw new AppError('DEVICE_NOT_FOUND', '授权设备不存在', 404);
    this.emit('revoked', row.token_hash); return { ok: true };
  }
  revokeAll() { this.db.exec('DELETE FROM device_requests; DELETE FROM device_grants'); this.emit('revoked'); }
}
