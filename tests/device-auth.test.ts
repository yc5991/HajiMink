import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DeviceAuth } from '../server/device-auth';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  let time = 1_700_000_000_000;
  return { db, auth: new DeviceAuth(db, () => time), advance: (ms: number) => { time += ms; } };
}
function grant(auth: DeviceAuth, name = '测试电脑', remember = false) {
  const request = auth.create(name, 'fixture');
  const details = auth.lookup(request.userCode, 'owner');
  auth.decide(details.approvalTicket, true, remember);
  return { request, issued: auth.exchange(request.requestId) };
}
it('persists only hashes, requires an owner approval and exchanges exactly once', () => {
  const { db, auth, advance } = fixture();
  const request = auth.create(' 我的电脑 ', 'client');
  expect(request).toMatchObject({ userCode: expect.stringMatching(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/), intervalSeconds: 2 });
  const before = JSON.stringify(db.prepare('SELECT * FROM device_requests').all());
  expect(before).not.toContain(request.requestId); expect(before).not.toContain(request.userCode.replace('-', ''));
  expect(auth.status(request.requestId).state).toBe('pending');
  expect(() => auth.status(request.requestId)).toThrowError(expect.objectContaining({ code: 'DEVICE_POLL_SLOW', statusCode: 429 }));
  expect(() => auth.exchange(request.requestId)).toThrowError(expect.objectContaining({ code: 'DEVICE_EXCHANGE_FAILED' }));
  const first = auth.lookup(request.userCode.toLowerCase(), 'owner');
  const second = auth.lookup(request.userCode, 'owner');
  expect(first.deviceName).toBe('我的电脑');
  expect(() => auth.decide(first.approvalTicket, true)).toThrowError(expect.objectContaining({ code: 'DEVICE_APPROVAL_EXPIRED' }));
  auth.decide(second.approvalTicket, true, true);
  expect(() => auth.decide(second.approvalTicket, true)).toThrowError(expect.objectContaining({ code: 'DEVICE_APPROVAL_EXPIRED' }));
  advance(2000); expect(auth.status(request.requestId).state).toBe('approved');
  const issued = auth.exchange(request.requestId);
  expect(issued.expiresAt - (request.expiresAt - 5 * 60 * 1000) - 2000).toBe(7 * 24 * 60 * 60 * 1000);
  const stored = JSON.stringify(db.prepare('SELECT * FROM device_grants').all());
  expect(stored).not.toContain(issued.token); expect(auth.session(issued.token)?.id).toBe(issued.deviceId);
  expect(() => auth.exchange(request.requestId)).toThrowError(expect.objectContaining({ code: 'DEVICE_EXCHANGE_FAILED' }));
  expect(auth.list()).toEqual([{ id: issued.deviceId, name: '我的电脑', createdAt: expect.any(Number), expiresAt: issued.expiresAt }]);
});
it('denial, cancellation, expiry and approval-ticket expiry never issue a credential', () => {
  const { auth, advance } = fixture();
  const denied = auth.create('拒绝设备', 'client');
  auth.decide(auth.lookup(denied.userCode, 'owner').approvalTicket, false);
  expect(auth.status(denied.requestId).state).toBe('denied');
  expect(() => auth.exchange(denied.requestId)).toThrowError(expect.objectContaining({ code: 'DEVICE_EXCHANGE_FAILED' }));
  const cancelled = auth.create('取消设备', 'client'); const ticket = auth.lookup(cancelled.userCode, 'owner').approvalTicket;
  auth.cancel(cancelled.requestId);
  expect(() => auth.decide(ticket, true)).toThrowError(expect.objectContaining({ code: 'DEVICE_APPROVAL_EXPIRED' }));
  expect(() => auth.status(cancelled.requestId)).toThrowError(expect.objectContaining({ code: 'DEVICE_REQUEST_EXPIRED' }));
  const expiredTicket = auth.create('确认超时', 'client'); const detail = auth.lookup(expiredTicket.userCode, 'owner');
  advance(120001);
  expect(() => auth.decide(detail.approvalTicket, true)).toThrowError(expect.objectContaining({ code: 'DEVICE_APPROVAL_EXPIRED' }));
  const expired = auth.create('请求超时', 'client'); advance(300000);
  expect(() => auth.status(expired.requestId)).toThrowError(expect.objectContaining({ code: 'DEVICE_REQUEST_EXPIRED' }));
  expect(() => auth.lookup(expired.userCode, 'owner')).toThrowError(expect.objectContaining({ code: 'DEVICE_CODE_INVALID' }));
  expect(auth.list()).toEqual([]);
});
it('enforces confirmation-code lookup limits and rejects misleading names and unknown secrets', () => {
  const { auth } = fixture();
  for (const bad of ['', '   ', 'x\u202eexample', 'x\u0000', 'x'.repeat(61)]) expect(() => auth.create(bad, 'client')).toThrowError(expect.objectContaining({ code: 'DEVICE_NAME_INVALID' }));
  for (let i = 0; i < 20; i++) expect(() => auth.lookup('AAAAAAAA', 'guessing-client')).toThrowError(expect.objectContaining({ code: 'DEVICE_CODE_INVALID' }));
  expect(() => auth.lookup('AAAAAAAA', 'guessing-client')).toThrowError(expect.objectContaining({ code: 'DEVICE_RATE_LIMIT' }));
  expect(auth.session('forged')).toBeUndefined();
});
it('revoke removes one grant, sends the hash for closing live connections, and revokeAll removes pending requests', () => {
  const { auth } = fixture(); const first = grant(auth, '设备一'); const second = grant(auth, '设备二');
  const onRevoked = vi.fn(); auth.on('revoked', onRevoked);
  const hash = auth.session(first.issued.token)!.hash;
  auth.revoke(first.issued.deviceId);
  expect(onRevoked).toHaveBeenCalledWith(hash); expect(auth.session(first.issued.token)).toBeUndefined();
  expect(auth.session(second.issued.token)).toBeDefined();
  const pending = auth.create('待审批', 'client'); auth.revokeAll();
  expect(auth.session(second.issued.token)).toBeUndefined(); expect(auth.list()).toEqual([]);
  expect(() => auth.status(pending.requestId)).toThrowError(expect.objectContaining({ code: 'DEVICE_REQUEST_EXPIRED' }));
  expect(onRevoked).toHaveBeenLastCalledWith();
});
it('rolls back a failed credential insert without consuming the approved request', () => {
  const { db, auth } = fixture(); const request = auth.create('事务测试', 'client');
  auth.decide(auth.lookup(request.userCode, 'owner').approvalTicket, true);
  db.exec("CREATE TRIGGER fail_grant BEFORE INSERT ON device_grants BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  expect(() => auth.exchange(request.requestId)).toThrow();
  expect(auth.status(request.requestId).state).toBe('approved');
  db.exec('DROP TRIGGER fail_grant');
  expect(auth.session(auth.exchange(request.requestId).token)).toBeDefined();
});
it('uses eight hours by default and expires tokens independently', () => {
  const { auth, advance } = fixture(); const device = grant(auth);
  expect(device.issued.expiresAt - (device.request.expiresAt - 300000)).toBe(8 * 60 * 60 * 1000);
  advance(8 * 60 * 60 * 1000); expect(auth.session(device.issued.token)).toBeUndefined(); expect(auth.list()).toEqual([]);
});
