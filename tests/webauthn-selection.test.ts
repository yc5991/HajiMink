import { expect, it } from 'vitest';
// @ts-expect-error Electron shell helper is CommonJS.
import { eligibleAccounts } from '../desktop/webauthn-selection.cjs';

function fixture() {
  const frame = { url: 'https://agent.example.com/account' };
  const content = { mainFrame: frame, isDestroyed: () => false };
  const details = { frame, relyingPartyId: 'example.com', accounts: [{ credentialId: 'test-id', name: 'owner', displayName: '私人工作台' }] };
  return { frame, content, details, origin: 'https://agent.example.com' };
}
it('allows only passkeys selected for the active main frame and valid relying party', () => {
  const f = fixture();
  expect(eligibleAccounts(f.details, f.content, f.origin)).toEqual([{ credentialId: 'test-id', label: '私人工作台 (owner)' }]);
  expect(eligibleAccounts({ ...f.details, frame: { url: f.frame.url } }, f.content, f.origin)).toEqual([]);
  expect(eligibleAccounts(f.details, f.content, 'https://other.example.com')).toEqual([]);
  expect(eligibleAccounts({ ...f.details, relyingPartyId: 'evil.com' }, f.content, f.origin)).toEqual([]);
  expect(eligibleAccounts({ ...f.details, relyingPartyId: 'ample.com' }, f.content, f.origin)).toEqual([]);
  expect(eligibleAccounts(f.details, { ...f.content, isDestroyed: () => true }, f.origin)).toEqual([]);
});
it('rejects malformed or excessive accounts and sanitizes display text', () => {
  const f = fixture();
  expect(eligibleAccounts({ ...f.details, accounts: [] }, f.content, f.origin)).toEqual([]);
  expect(eligibleAccounts({ ...f.details, accounts: Array.from({ length: 11 }, (_, i) => ({ credentialId: String(i) })) }, f.content, f.origin)).toEqual([]);
  expect(eligibleAccounts({ ...f.details, accounts: [{ credentialId: 'x' }, { credentialId: 'x' }] }, f.content, f.origin)).toEqual([]);
  expect(eligibleAccounts({ ...f.details, accounts: [{ credentialId: '' }] }, f.content, f.origin)).toEqual([]);
  expect(eligibleAccounts({ ...f.details, accounts: [{ credentialId: 'x', name: 'a\n\u0000b' }] }, f.content, f.origin)).toEqual([{ credentialId: 'x', label: 'a b' }]);
});
