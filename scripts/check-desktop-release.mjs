import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import asar from '@electron/asar';
import { inspectText, privateMarkersFromEnv } from './check-release.mjs';

const textExtension = /\.(?:cjs|mjs|js|json|html|css|md|txt|cs|map)$/i;
const runtimeFile = /^(?:gateway\.sqlite(?:-shm|-wal)?|gateway\.(?:stdout|stderr)\.log|controller\.instance\.json|connections\.json|tunnel-token|\.env(?:\..*)?)$/i;

function walk(root, visit) {
  if (!fs.existsSync(root)) throw new Error(`Missing packaged directory: ${root}`);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected packaged link: ${file}`);
    if (entry.isDirectory()) walk(file, visit);
    else if (entry.isFile()) visit(file);
    else throw new Error(`Unexpected packaged entry: ${file}`);
  }
}

export function inspectDesktopRelease(root, privateMarkers = []) {
  const resources = path.join(root, 'resources');
  const archive = path.join(resources, 'app.asar');
  const gateway = path.join(resources, 'gateway');
  const required = [
    path.join(root, 'HajiMink.exe'), archive,
    path.join(gateway, 'dist', 'index.html'), path.join(gateway, 'dist-server', 'index.js'),
    path.join(gateway, 'runtime', 'node.exe'), path.join(gateway, 'controller', 'PrivateControlPipe.exe'),
    path.join(resources, 'licenses', 'HajiMink-LICENSE.txt'),
    path.join(resources, 'licenses', 'DEPENDENCIES.md'), path.join(resources, 'licenses', 'BRAND-ASSETS.md')
  ];
  for (const file of required) if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing packaged file: ${file}`);
  const issues = []; let checkedText = 0; let checkedFiles = 0;
  const check = (name, bytes) => {
    checkedText++;
    if (bytes.includes(0)) { issues.push(`${name}: unexpected binary content`); return; }
    issues.push(...inspectText(name, bytes.toString('utf8'), { privateMarkers, checkEmail: false }));
  };
  for (const entry of asar.listPackage(archive)) {
    const name = entry.replaceAll('\\', '/').replace(/^\//, '');
    if (runtimeFile.test(path.posix.basename(name))) issues.push(`app.asar/${name}: runtime data file`);
    if (textExtension.test(name)) check(`app.asar/${name}`, asar.extractFile(archive, path.join(...name.split('/'))));
  }
  walk(gateway, file => {
    checkedFiles++;
    const rel = path.relative(resources, file).replaceAll('\\', '/');
    if (runtimeFile.test(path.basename(file))) issues.push(`${rel}: runtime data file`);
    if (textExtension.test(file)) {
      const bytes = fs.readFileSync(file);
      if (!rel.startsWith('gateway/node_modules/')) check(rel, bytes);
      else if (privateMarkers.length && !bytes.includes(0)) {
        const text = bytes.toString('utf8').toLowerCase();
        if (privateMarkers.some(marker => text.includes(marker.toLowerCase()))) issues.push(`${rel}: private marker`);
      }
    }
  });
  walk(path.join(resources, 'licenses'), file => { if (textExtension.test(file)) check(path.relative(resources, file).replaceAll('\\', '/'), fs.readFileSync(file)); });
  return { issues, checkedText, checkedFiles };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (!process.argv[2]) throw new Error('Provide the unpacked Windows application directory');
    const result = inspectDesktopRelease(path.resolve(process.argv[2]), privateMarkersFromEnv());
    if (result.issues.length) { console.error(result.issues.join('\n')); process.exitCode = 1; }
    else console.log(`PASS desktop release privacy check: ${result.checkedText} first-party text files and ${result.checkedFiles} gateway files inspected`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
