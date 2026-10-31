'use strict';
// The setup destination is bound to one managed gateway and one generation
// displayed by this desktop process. No setup code is ever part of the URL.
const { normalizeAddress } = require('./connections.cjs');

function sameSetupGateway(binding, gateway) {
  return !!binding && !!gateway && gateway.state === 'ready' && gateway.managed === true && gateway.mode === 'owner' && gateway.setupPending === true && gateway.awaitingPublicOrigin !== true &&
    gateway.publicOrigin === binding.origin && gateway.port === binding.port && gateway.pid === binding.pid && gateway.controllerPid === binding.controllerPid;
}
function createSetupBinding(gateway, expiresAt, now = Date.now()) {
  if (!gateway || gateway.publicOrigin === 'https://hajimink-setup.invalid' || !Number.isSafeInteger(gateway.port) || gateway.port < 1024 || gateway.port > 65535 ||
      !Number.isSafeInteger(gateway.pid) || gateway.pid < 1 || !Number.isSafeInteger(gateway.controllerPid) || gateway.controllerPid < 1 ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 15 * 60 * 1000) throw new Error('无法确认设置码对应的网关');
  const origin = normalizeAddress(gateway.publicOrigin);
  if (origin !== gateway.publicOrigin || new URL(origin).protocol !== 'https:') throw new Error('无法确认设置码对应的地址');
  const binding = { origin, port: gateway.port, pid: gateway.pid, controllerPid: gateway.controllerPid, expiresAt };
  if (!sameSetupGateway(binding, gateway)) throw new Error('无法确认设置码对应的网关');
  return Object.freeze(binding);
}
function setupNavigationUrl(binding, gateway, input, now = Date.now()) {
  if (!sameSetupGateway(binding, gateway)) throw new Error('网关或设置码已变化，请在本机重新生成设置码');
  if (!Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= now) throw new Error('设置码已过期，请在本机重新生成');
  let entered;
  try { entered = normalizeAddress(input); } catch { throw new Error('请先恢复与设置码对应的已保存地址'); }
  if (entered !== binding.origin) throw new Error('输入地址与设置码对应的已保存地址不同，请先恢复已保存地址');
  return new URL('/', binding.origin).href;
}
module.exports = { createSetupBinding, sameSetupGateway, setupNavigationUrl };
