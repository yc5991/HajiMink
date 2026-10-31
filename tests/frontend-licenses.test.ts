import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createFrontendNotices } from '../scripts/frontend-licenses';
import { removeTempFixture } from './safe-temp';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) removeTempFixture(directory, 'hajimink-license-test-'); });

it('collects and deduplicates the complete license and notice texts without local paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-license-test-')); directories.push(dir);
  const root = path.join(dir, 'node_modules', '@scope', 'package'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@scope/package', version: '1.2.3' }));
  fs.writeFileSync(path.join(root, 'LICENSE-MIT'), 'Copyright fixture');
  fs.writeFileSync(path.join(root, 'NOTICE'), 'Attribution fixture');
  const notices = createFrontendNotices([path.join(root, 'index.js'), path.join(root, 'other.js')]);
  expect(notices).toContain('=== @scope/package@1.2.3 ===');
  expect(notices).toContain('Copyright fixture');
  expect(notices).toContain('Attribution fixture');
  expect(notices.match(/=== @scope\/package@1\.2\.3 ===/g)).toHaveLength(1);
  expect(notices).not.toContain(dir);
});

it('fails the build when a bundled package has no license text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-license-test-')); directories.push(dir);
  const root = path.join(dir, 'node_modules', 'missing-license'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'missing-license', version: '1.0.0' }));
  expect(() => createFrontendNotices([path.join(root, 'index.js')])).toThrow('Missing license file for bundled dependency');
});
