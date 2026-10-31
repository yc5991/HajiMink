'use strict';
// Device tokens never enter a renderer. Persist only when the OS provides a
// real protection backend; otherwise retain them for this process only.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const linuxBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
class DeviceCredentials {
  constructor(directory, storage, platform = process.platform) { this.root = path.join(directory, 'device-credentials'); this.storage = storage; this.platform = platform; this.memory = new Map(); }
  file(id) { if (!idPattern.test(id)) throw new Error('连接标识无效'); return path.join(this.root, `${id}.bin`); }
  valid(item, value) {
    return value && value.id === item.id && value.origin === item.url && typeof value.token === 'string' && tokenPattern.test(value.token) && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now();
  }
  async protectedAvailable() {
    try {
      if (this.platform === 'linux' && !linuxBackends.has(this.storage.getSelectedStorageBackend())) return false;
      return await this.storage.isAsyncEncryptionAvailable();
    } catch { return false; }
  }
  async get(item) {
    this.file(item.id);
    const current = this.memory.get(item.id);
    if (this.valid(item, current)) return current;
    this.memory.delete(item.id);
    if (!(await this.protectedAvailable())) return undefined;
    try {
      const file = this.file(item.id), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || stat.size < 1) return undefined;
      const result = await this.storage.decryptStringAsync(await fs.readFile(file));
      const value = JSON.parse(result.result);
      if (!this.valid(item, value)) return undefined;
      this.memory.set(item.id, value); return value;
    } catch { return undefined; }
  }
  async save(item, grant) {
    const file = this.file(item.id);
    const value = { id: item.id, origin: item.url, token: grant.token, expiresAt: grant.expiresAt };
    if (!this.valid(item, value)) throw new Error('设备凭据无效或已过期');
    this.memory.set(item.id, value);
    // A replaced grant must not resurrect an older encrypted file on restart.
    await fs.rm(file, { force: true });
    if (!(await this.protectedAvailable())) return 'memory';
    let temp;
    try {
      const encrypted = await this.storage.encryptStringAsync(JSON.stringify(value));
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > 8192) throw new Error('加密结果无效');
      await fs.mkdir(this.root, { recursive: true });
      temp = path.join(this.root, `${randomUUID()}.tmp`);
      await fs.writeFile(temp, encrypted, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, file); return 'protected';
    } catch { if (temp) await fs.rm(temp, { force: true }).catch(() => {}); return 'memory'; }
  }
  async remove(id) { this.memory.delete(id); await fs.rm(this.file(id), { force: true }); }
}
module.exports = { DeviceCredentials };
