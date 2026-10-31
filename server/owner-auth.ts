import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { AppError } from './errors.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export interface OwnerSession { hash: string; expiresAt: number; createdAt: number; }
export interface OwnerSetupConfig { generation: string; codeHash: string; expiresAt: number; }
const setupGeneration = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const setupToken = /^[A-Za-z0-9_-]{43}$/;
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));

export class OwnerAuth extends EventEmitter {
  private attempts = new Map<string, { count: number; until: number }>();
  private hashing = 0;
  private setupGeneration?: string;
  readonly origin: string;
  readonly rpID: string;
  constructor(readonly db: DatabaseSync, origin: string, private now = () => Date.now()) {
    super();
    this.origin = new URL(origin).origin;
    this.rpID = new URL(origin).hostname;
    db.exec(`CREATE TABLE IF NOT EXISTS owner_identity(id INTEGER PRIMARY KEY CHECK(id=1), user_handle TEXT NOT NULL, password_salt TEXT, password_hash TEXT);
      CREATE TABLE IF NOT EXISTS owner_security_state(id INTEGER PRIMARY KEY CHECK(id=1), auth_revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_sessions(hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_passkeys(id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_challenges(hash TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL, binding TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_setup(id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, session_hash TEXT, binding_hash TEXT, session_expires_at INTEGER);`);
    db.prepare('INSERT OR IGNORE INTO owner_identity(id,user_handle) VALUES(1,?)').run(secret());
    db.prepare('INSERT OR IGNORE INTO owner_security_state(id,auth_revision) VALUES(1,0)').run();
  }
  get passwordEnabled() { return !!(this.db.prepare('SELECT password_hash FROM owner_identity WHERE id=1').get() as any)?.password_hash; }
  get configured() { return this.passwordEnabled || this.passkeys().length > 0; }
  passkeys() { return this.db.prepare('SELECT id,public_key,counter,transports,created_at FROM owner_passkeys ORDER BY created_at').all() as any[]; }
  summary() { return { configured: this.configured, passwordEnabled: this.passwordEnabled, passkeyCount: this.passkeys().length }; }
  // Only the verified desktop controller writes this descriptor; it contains a
  // digest, never the one-time setup code. A used generation stays used across restarts.
  prepareSetup(value: unknown): boolean {
    if (this.configured || !value || typeof value !== 'object') return false;
    const input = value as Partial<OwnerSetupConfig>;
    if (typeof input.generation !== 'string' || !setupGeneration.test(input.generation) ||
        typeof input.codeHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.codeHash) ||
        !Number.isSafeInteger(input.expiresAt) || input.expiresAt! <= 0 || input.expiresAt! > this.now() + 15 * 60 * 1000) return false;
    const prior = this.db.prepare('SELECT generation,code_hash,expires_at FROM owner_setup WHERE id=1').get() as any;
    if (prior?.generation === input.generation) {
      if (prior.code_hash !== input.codeHash || prior.expires_at !== input.expiresAt) return false;
    } else {
      this.db.prepare(`INSERT INTO owner_setup(id,generation,code_hash,expires_at,used_at,session_hash,binding_hash,session_expires_at)
        VALUES(1,?,?,?,NULL,NULL,NULL,NULL) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,code_hash=excluded.code_hash,
        expires_at=excluded.expires_at,used_at=NULL,session_hash=NULL,binding_hash=NULL,session_expires_at=NULL`).run(input.generation, input.codeHash, input.expiresAt!);
    }
    this.setupGeneration = input.generation;
    return true;
  }
  get setupPending() { return !!this.setupGeneration && !this.configured; }
  setupSession(token: string | undefined, binding: string | undefined): boolean {
    if (!this.setupPending || !token || !binding || !setupToken.test(token) || !setupToken.test(binding)) return false;
    return !!this.db.prepare('SELECT 1 FROM owner_setup WHERE id=1 AND generation=? AND session_hash=? AND binding_hash=? AND session_expires_at>?')
      .get(this.setupGeneration!, hash(token), hash(binding), this.now());
  }
  setupStatus(token?: string, binding?: string) {
    if (!this.setupPending) return { setupPending: false, setupCodeAvailable: false, setupSession: false };
    const row = this.db.prepare('SELECT used_at,expires_at FROM owner_setup WHERE id=1 AND generation=?').get(this.setupGeneration!) as any;
    return { setupPending: true, setupCodeAvailable: !!row && row.used_at === null && row.expires_at > this.now(), setupSession: this.setupSession(token, binding) };
  }
  exchangeSetupCode(code: string, binding: string, client: string) {
    this.limit(`setup-code:${client}`, 8); this.limit('setup-code-total', 80);
    if (!this.setupPending || !setupToken.test(code) || !setupToken.test(binding)) throw new AppError('SETUP_INVALID', '设置码无效、已使用或已过期，请在本机重新生成', 409);
    const token = secret(); const now = this.now();
    // One SQL statement consumes the code and creates a browser-bound, restricted
    // session. The NOT EXISTS conditions also protect concurrent initialization.
    const row = this.db.prepare(`UPDATE owner_setup SET used_at=?,session_hash=?,binding_hash=?,session_expires_at=MIN(expires_at,?)
      WHERE id=1 AND generation=? AND code_hash=? AND used_at IS NULL AND expires_at>?
      AND NOT EXISTS (SELECT 1 FROM owner_identity WHERE id=1 AND password_hash IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM owner_passkeys) RETURNING session_expires_at`)
      .get(now, hash(token), hash(binding), now + 5 * 60 * 1000, this.setupGeneration!, hash(code), now) as any;
    if (!row) throw new AppError('SETUP_INVALID', '设置码无效、已使用或已过期，请在本机重新生成', 409);
    return { token, expiresAt: row.session_expires_at as number, maxAge: Math.max(0, Math.floor((row.session_expires_at - now) / 1000)) };
  }
  private prune() {
    this.db.prepare('DELETE FROM owner_sessions WHERE expires_at<=?').run(this.now());
    this.db.prepare('DELETE FROM owner_challenges WHERE expires_at<=?').run(this.now());
    for (const [key, attempt] of this.attempts) if (attempt.until <= this.now()) this.attempts.delete(key);
  }
  session(token?: string): OwnerSession | undefined {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const row = this.db.prepare('SELECT hash,created_at,expires_at FROM owner_sessions WHERE hash=? AND expires_at>?').get(hash(token), this.now()) as any;
    return row ? { hash: row.hash, createdAt: row.created_at, expiresAt: row.expires_at } : undefined;
  }
  validSessionHash(sessionHash: string) { return !!this.db.prepare('SELECT 1 FROM owner_sessions WHERE hash=? AND expires_at>?').get(sessionHash, this.now()); }
  issueSession(remember = false) {
    this.prune();
    const token = secret(); const createdAt = this.now(); const expiresAt = createdAt + (remember ? 7 * 24 : 8) * 60 * 60 * 1000;
    this.db.prepare('INSERT INTO owner_sessions VALUES(?,?,?)').run(hash(token), createdAt, expiresAt);
    return { token, expiresAt, maxAge: Math.floor((expiresAt - createdAt) / 1000) };
  }
  revoke(sessionHash: string) { this.db.prepare('DELETE FROM owner_sessions WHERE hash=?').run(sessionHash); this.emit('revoked', sessionHash); }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  private authRevision(): number { return Number((this.db.prepare('SELECT auth_revision FROM owner_security_state WHERE id=1').get() as any).auth_revision); }
  private assertAuthRevision(revision: number) {
    if (this.authRevision() !== revision) throw new AppError('AUTH_CHANGED', '登录状态已更改，请重新登录后重试', 401);
  }
  private assertEnrollment(sessionHash?: string) {
    if (sessionHash === undefined) return; // Local and Access modes are already their own enrollment authority.
    const session = this.db.prepare('SELECT created_at,expires_at FROM owner_sessions WHERE hash=?').get(sessionHash) as any;
    if (!session || session.expires_at <= this.now() || this.now() - session.created_at > 5 * 60 * 1000) throw new AppError('REAUTHENTICATE', '请重新登录后再管理登录方式', 401);
  }
  private invalidateAllInTransaction() {
    this.db.exec('UPDATE owner_security_state SET auth_revision=auth_revision+1 WHERE id=1; DELETE FROM owner_sessions;');
  }
  issueSessionAtRevision(revision: number, remember = false) {
    return this.transaction(() => { this.assertAuthRevision(revision); return this.issueSession(remember); });
  }
  issueSessionAfterEnrollment(revision: number, sessionHash: string) {
    const issued = this.transaction(() => {
      this.assertAuthRevision(revision); this.assertEnrollment(sessionHash);
      this.db.prepare('DELETE FROM owner_sessions WHERE hash=?').run(sessionHash);
      return this.issueSession(false);
    });
    this.emit('revoked', sessionHash);
    return issued;
  }
  revokeAll() {
    // Revoke existing sessions and invalidate in-flight authentication together.
    this.transaction(() => this.invalidateAllInTransaction());
    this.emit('revoked');
  }
  private limit(key: string, maximum: number) {
    this.prune();
    const id = hash(key); const attempt = this.attempts.get(id) || { count: 0, until: this.now() + 15 * 60 * 1000 };
    if (attempt.count >= maximum || this.attempts.size > 4000) throw new AppError('LOGIN_RATE_LIMIT', '尝试过于频繁，请稍后再试', 429);
    attempt.count++; this.attempts.set(id, attempt);
  }
  private async passwordHash(password: string, salt: string) {
    if (this.hashing >= 2) throw new AppError('LOGIN_BUSY', '正在处理登录，请稍后重试', 429);
    this.hashing++;
    try { return await derive(password, salt); } finally { this.hashing--; }
  }
  private validatePassword(password: string) {
    if (password.trim().length < 12 || /^(.)\1+$/u.test(password) || Buffer.byteLength(password) > 1024) throw new AppError('PASSWORD_POLICY', '密码至少 12 个字符，建议使用较长的短语', 400);
  }
  async setPassword(password: string, sessionHash?: string) {
    this.validatePassword(password);
    const revision = this.authRevision();
    const salt = secret(); const result = await this.passwordHash(password, salt);
    const updatedRevision = this.transaction(() => {
      this.assertAuthRevision(revision); this.assertEnrollment(sessionHash);
      this.db.prepare('UPDATE owner_identity SET password_salt=?,password_hash=? WHERE id=1').run(salt, result.toString('base64url'));
      this.invalidateAllInTransaction();
      return this.authRevision();
    });
    this.emit('revoked');
    return updatedRevision;
  }
  async setInitialPassword(password: string, binding: string, setupSession: string | undefined) {
    if (!this.setupSession(setupSession, binding)) throw new AppError('SETUP_EXPIRED', '首次设置已过期，请在本机重新生成设置码', 409);
    this.validatePassword(password);
    const salt = secret(); const result = await this.passwordHash(password, salt);
    const updatedRevision = this.transaction(() => {
      if (!this.setupSession(setupSession, binding)) throw new AppError('SETUP_EXPIRED', '首次设置已完成或已过期', 409);
      this.db.prepare('UPDATE owner_identity SET password_salt=?,password_hash=? WHERE id=1').run(salt, result.toString('base64url'));
      this.db.prepare('UPDATE owner_setup SET session_hash=NULL,binding_hash=NULL,session_expires_at=NULL WHERE id=1 AND generation=?').run(this.setupGeneration!);
      this.invalidateAllInTransaction();
      return this.authRevision();
    });
    this.emit('revoked');
    return updatedRevision;
  }
  async loginPassword(password: string, client: string, remember: boolean) {
    this.limit(`password:${client}`, 10); this.limit('password-total', 100);
    const revision = this.authRevision();
    const row = this.db.prepare('SELECT password_salt,password_hash FROM owner_identity WHERE id=1').get() as any;
    const result = await this.passwordHash(password, row?.password_salt || 'not-configured');
    const expected = row?.password_hash ? Buffer.from(row.password_hash, 'base64url') : Buffer.alloc(64);
    if (!row?.password_hash || result.length !== expected.length || !timingSafeEqual(result, expected)) throw new AppError('LOGIN_FAILED', '密码不正确', 401);
    return this.transaction(() => {
      this.assertAuthRevision(revision);
      // Detect a password written by an older process that lacks revisions, too.
      const current = this.db.prepare('SELECT password_salt,password_hash FROM owner_identity WHERE id=1').get() as any;
      if (current?.password_salt !== row.password_salt || current?.password_hash !== row.password_hash) throw new AppError('AUTH_CHANGED', '登录状态已更改，请重新登录后重试', 401);
      this.attempts.delete(hash(`password:${client}`));
      return this.issueSession(remember);
    });
  }
  private challenge(value: string, kind: string, binding: string) {
    this.prune(); const id = secret();
    this.db.prepare('INSERT INTO owner_challenges VALUES(?,?,?,?,?)').run(hash(id), value, kind, hash(binding), this.now() + 5 * 60 * 1000);
    return id;
  }
  private takeChallenge(id: string, kind: string, binding: string) {
    const row = this.db.prepare('DELETE FROM owner_challenges WHERE hash=? AND kind=? AND binding=? AND expires_at>? RETURNING challenge').get(hash(id), kind, hash(binding), this.now()) as any;
    if (!row) throw new AppError('CHALLENGE_EXPIRED', '验证已过期，请重新开始', 409);
    return row.challenge as string;
  }
  async registrationOptions(binding: string, kind: 'register' | 'setup-register' = 'register') {
    if (this.passkeys().length >= 10) throw new AppError('PASSKEY_LIMIT', '最多保存 10 个通行密钥', 400);
    const owner = this.db.prepare('SELECT user_handle FROM owner_identity WHERE id=1').get() as any;
    const options = await generateRegistrationOptions({ rpName: 'Agent Control', rpID: this.rpID, userName: 'owner', userDisplayName: '私人工作台', userID: new Uint8Array(Buffer.from(owner.user_handle, 'base64url')), attestationType: 'none', supportedAlgorithmIDs: [-7, -257], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: this.passkeys().map(p => ({ id: p.id, transports: JSON.parse(p.transports) })) });
    return { options, challengeId: this.challenge(options.challenge, kind, binding) };
  }
  private async verifiedRegistration(id: string, response: RegistrationResponseJSON, binding: string, kind: 'register' | 'setup-register') {
    const challenge = this.takeChallenge(id, kind, binding);
    let result;
    try { result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: this.origin, expectedRPID: this.rpID, requireUserVerification: true }); }
    catch { throw new AppError('PASSKEY_INVALID', '通行密钥验证失败，请重新添加', 400); }
    if (!result.verified || !result.registrationInfo) throw new AppError('PASSKEY_INVALID', '通行密钥未通过验证', 400);
    return result.registrationInfo.credential;
  }
  private savePasskey(credential: Awaited<ReturnType<OwnerAuth['verifiedRegistration']>>) {
    this.db.prepare('INSERT INTO owner_passkeys VALUES(?,?,?,?,?)').run(credential.id, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports || []), this.now());
  }
  async registerPasskey(id: string, response: RegistrationResponseJSON, binding: string, sessionHash?: string) {
    const revision = this.authRevision();
    const credential = await this.verifiedRegistration(id, response, binding, 'register');
    return this.transaction(() => {
      this.assertAuthRevision(revision); this.assertEnrollment(sessionHash);
      if (this.passkeys().length >= 10) throw new AppError('PASSKEY_LIMIT', '最多保存 10 个通行密钥', 400);
      this.savePasskey(credential);
      return revision;
    });
  }
  async registerInitialPasskey(id: string, response: RegistrationResponseJSON, binding: string, setupSession: string | undefined) {
    if (!this.setupSession(setupSession, binding)) throw new AppError('SETUP_EXPIRED', '首次设置已过期，请在本机重新生成设置码', 409);
    const credential = await this.verifiedRegistration(id, response, binding, 'setup-register');
    // Recheck under an exclusive write transaction: another in-flight request
    // must not register a second initial credential or replace an existing owner.
    const updatedRevision = this.transaction(() => {
      if (!this.setupSession(setupSession, binding)) throw new AppError('SETUP_EXPIRED', '首次设置已完成或已过期', 409);
      this.savePasskey(credential);
      this.db.prepare('UPDATE owner_setup SET session_hash=NULL,binding_hash=NULL,session_expires_at=NULL WHERE id=1 AND generation=?').run(this.setupGeneration!);
      this.invalidateAllInTransaction();
      return this.authRevision();
    });
    // No stale owner or device grants may survive initialization.
    this.emit('revoked');
    return updatedRevision;
  }
  async authenticationOptions(binding: string, client: string) {
    this.limit(`passkey-challenge:${client}`, 40); this.limit('passkey-challenge-total', 300);
    const options = await generateAuthenticationOptions({ rpID: this.rpID, userVerification: 'required' });
    return { options, challengeId: this.challenge(options.challenge, 'login', binding) };
  }
  async loginPasskey(id: string, response: AuthenticationResponseJSON, binding: string, remember: boolean) {
    const revision = this.authRevision();
    const challenge = this.takeChallenge(id, 'login', binding);
    const row = this.db.prepare('SELECT * FROM owner_passkeys WHERE id=?').get(response.id) as any;
    if (!row) throw new AppError('LOGIN_FAILED', '这个通行密钥没有在本站注册', 401);
    let result;
    try { result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: this.origin, expectedRPID: this.rpID, requireUserVerification: true, credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports) } }); }
    catch { throw new AppError('LOGIN_FAILED', '通行密钥验证失败，请重新登录', 401); }
    if (!result.verified) throw new AppError('LOGIN_FAILED', '通行密钥未通过验证', 401);
    return this.transaction(() => {
      this.assertAuthRevision(revision);
      // Reject an assertion checked against a removed, replaced or updated key.
      const update = this.db.prepare('UPDATE owner_passkeys SET counter=? WHERE id=? AND counter=? AND public_key=?').run(result.authenticationInfo.newCounter, row.id, row.counter, row.public_key);
      if (Number(update.changes) !== 1) throw new AppError('AUTH_CHANGED', '登录状态已更改，请重新登录后重试', 401);
      return this.issueSession(remember);
    });
  }
}
