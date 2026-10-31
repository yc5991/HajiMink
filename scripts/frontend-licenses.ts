import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

export function createFrontendNotices(moduleIds: Iterable<string>): string {
  const roots = new Set<string>();
  for (const id of moduleIds) {
    if (id.startsWith('\0')) continue;
    const normalized = id.replaceAll('\\', '/').split('?')[0];
    const marker = '/node_modules/';
    const index = normalized.lastIndexOf(marker);
    if (index < 0) continue;
    const rest = normalized.slice(index + marker.length).split('/');
    const name = rest[0]?.startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
    if (!name) continue;
    roots.add(path.resolve(normalized.slice(0, index + marker.length), name));
  }

  const packages = [...roots].map(root => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const files = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:$|[.\-_])/i.test(entry.name))
      .map(entry => entry.name).sort();
    if (!files.length) throw new Error(`Missing license file for bundled dependency: ${manifest.name}@${manifest.version}`);
    return {
      name: String(manifest.name), version: String(manifest.version),
      notices: files.map(file => `--- ${file} ---\n${fs.readFileSync(path.join(root, file), 'utf8').trim()}`).join('\n\n')
    };
  }).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));

  return `Third-party notices for dependencies included in the web application.\n\n${packages.map(pkg => `=== ${pkg.name}@${pkg.version} ===\n\n${pkg.notices}`).join('\n\n')}\n`;
}

export function frontendLicenses(): Plugin {
  return {
    name: 'hajimink-frontend-licenses',
    apply: 'build',
    generateBundle(_options, bundle) {
      const modules: string[] = [];
      for (const item of Object.values(bundle)) if (item.type === 'chunk') modules.push(...Object.keys(item.modules));
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: createFrontendNotices(modules) });
    }
  };
}
