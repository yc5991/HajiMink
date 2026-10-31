'use strict';

const CATALOG = Object.freeze([
  { id: 'other', label: '其他地址', optionLabel: '其他已配置地址', tunnel: false },
  { id: 'self-hosted', label: '自建服务器', tunnel: true },
  { id: 'natapp', label: 'NATAPP', tunnel: true, guide: 'https://natapp.cn/article/natapp_newbie' },
  { id: 'sakurafrp', label: 'SakuraFrp', tunnel: true, guide: 'https://doc.natfrp.com/app/http.html' },
  { id: 'tailscale', label: 'Tailscale', tunnel: true, guide: 'https://tailscale.com/docs/features/tailscale-funnel' },
  { id: 'cloudflare', label: 'Cloudflare Tunnel', tunnel: true, guide: 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/' }
].map(Object.freeze));
const PROVIDER_GUIDES = Object.freeze(Object.fromEntries(CATALOG.filter(item => item.guide).map(item => [item.id, item.guide])));
const EXTRA_GUIDES = Object.freeze({ 'tailscale-serve': 'https://tailscale.com/kb/1242/tailscale-serve', 'natapp-config': 'https://natapp.cn/article/config_ini' });
const PROVIDERS = Object.freeze(CATALOG.map(item => item.id));
const TUNNEL_PROVIDERS = Object.freeze(CATALOG.filter(item => item.tunnel).map(item => item.id));

function providerGuide(provider) {
  if (typeof provider !== 'string') throw new Error('该连接方式没有官方指南');
  if (Object.hasOwn(PROVIDER_GUIDES, provider)) return PROVIDER_GUIDES[provider];
  if (Object.hasOwn(EXTRA_GUIDES, provider)) return EXTRA_GUIDES[provider];
  throw new Error('该连接方式没有官方指南');
}

const catalog = Object.freeze({ CATALOG, PROVIDERS, TUNNEL_PROVIDERS, providerGuide });
if (typeof module === 'object' && module.exports) module.exports = catalog;
else globalThis.HajiminkProviders = catalog;
