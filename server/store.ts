import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from './errors.js';
export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true }); this.db = new DatabaseSync(path.join(directory, 'gateway.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      UPDATE operations SET state='unknown' WHERE state='pending';`);
  }
  async operation(id: string, action: string, entity: string, payload: unknown, run: () => Promise<unknown>) {
    const fingerprint = createHash('sha256').update(JSON.stringify([action, entity, payload])).digest('hex');
    const old = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as any;
    if (old) {
      if (old.fingerprint !== fingerprint) throw new AppError('OPERATION_CONFLICT', '操作标识与原提交内容不一致', 409);
      if (old.state === 'succeeded') return JSON.parse(old.result);
      throw new AppError('OPERATION_UNCONFIRMED', old.state === 'failed' ? '此前操作未成功，请确认状态后重新提交' : '该操作已提交，仍待核实，请勿重复执行', 409);
    }
    if (action === 'respond' && this.db.prepare("SELECT id FROM operations WHERE action='respond' AND entity=? AND state IN ('pending','succeeded','unknown') LIMIT 1").get(entity)) throw new AppError('STALE_REQUEST', '该审批已有处理记录，请刷新会话', 409);
    this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,NULL,?)').run(id, fingerprint, action, entity, 'pending', Date.now());
    try {
      const result = await run(); this.db.prepare('UPDATE operations SET state=?,result=? WHERE id=?').run('succeeded', JSON.stringify(result), id); return result;
    } catch (error) {
      const unknown = error instanceof AppError && ['DESKTOP_TIMEOUT', 'DESKTOP_OFFLINE'].includes(error.code);
      this.db.prepare('UPDATE operations SET state=? WHERE id=?').run(unknown ? 'unknown' : 'failed', id); throw error;
    }
  }
  getPreferences(harness = 'codex') {
    const all = Object.fromEntries((this.db.prepare('SELECT key,value FROM preferences').all() as any[]).map(x => [x.key, JSON.parse(x.value)]));
    const prefix = harness === 'codex' ? '' : 'harness:' + harness + ':';
    return { theme: all.theme, selectedThread: all[prefix + 'selectedThread'] ?? null, selectedProject: all[prefix + 'selectedProject'] ?? null };
  }
  setPreferences(values: Record<string, unknown>, harness = 'codex') { const update = this.db.prepare('INSERT INTO preferences VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'); for (const [key, value] of Object.entries(values)) update.run(key === 'theme' || harness === 'codex' ? key : 'harness:' + harness + ':' + key, JSON.stringify(value)); }
  close() { this.db.close(); }
}
