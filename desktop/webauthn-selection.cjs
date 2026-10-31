'use strict';
// Keep untrusted remote account names and frames out of native UI decisions.
function label(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}
function eligibleAccounts(details, content, expectedOrigin) {
  try {
    if (!details || !content || content.isDestroyed() || !details.frame || details.frame !== content.mainFrame) return [];
    const origin = new URL(expectedOrigin), frame = new URL(details.frame.url);
    if (frame.origin !== origin.origin) return [];
    const host = origin.hostname.toLowerCase(), rp = typeof details.relyingPartyId === 'string' ? details.relyingPartyId.toLowerCase() : '';
    if (!rp || !/^[a-z0-9.-]+$/.test(rp) || !(host === rp || host.endsWith(`.${rp}`))) return [];
    if (!Array.isArray(details.accounts) || !details.accounts.length || details.accounts.length > 10) return [];
    const seen = new Set();
    const accounts = [];
    for (const account of details.accounts) {
      if (!account || typeof account.credentialId !== 'string' || !account.credentialId || account.credentialId.length > 4096 || seen.has(account.credentialId)) return [];
      seen.add(account.credentialId);
      const display = label(account.displayName), name = label(account.name);
      accounts.push({ credentialId: account.credentialId, label: display && name && display !== name ? `${display} (${name})` : display || name || '通行密钥' });
    }
    return accounts;
  } catch { return []; }
}
module.exports = { eligibleAccounts };
