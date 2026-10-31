import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const forbiddenParts = new Set(['.local', '.git', 'node_modules', 'dist', 'dist-next', 'dist-server', 'dist-server-next', 'output', 'coverage', 'test-results']);
const extensions = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.css', '.json', '.md', '.yml', '.yaml', '.svg', '.mmd', '.ps1', '.cs', '.html', '.png', '.ico']);
const rootFiles = new Set(['LICENSE', '.editorconfig', '.gitignore', '.gitattributes']);
function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid release manifest path');
  return value;
}
function forbidden(file) {
  return file.split('/').some(p => forbiddenParts.has(p.toLowerCase())) || /(?:^|\/)tunnel-token$|\.(?:sqlite(?:-\w+)?|db|log|pem|key|pfx|p12|exe|dll|zip)$/i.test(file) || /(?:^|\/)\.env(?:$|\.)/.test(file);
}
export function releaseFiles(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8'));
  if (!Array.isArray(manifest.directories) || !Array.isArray(manifest.files)) throw new Error('Invalid release manifest');
  const files = new Set();
  const walk = value => {
    const rel = relative(value); const absolute = path.join(root, rel); const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in a release: ${rel}`);
    if (forbidden(rel)) throw new Error(`Runtime or private file in release manifest: ${rel}`);
    if (stat.isDirectory()) { for (const name of fs.readdirSync(absolute).sort()) walk(`${rel}/${name}`); }
    else if (stat.isFile()) files.add(rel);
    else throw new Error(`Unsupported release entry: ${rel}`);
  };
  for (const dir of manifest.directories) walk(dir);
  for (const file of manifest.files) walk(file);
  return [...files].sort();
}
export function privateMarkersFromEnv() {
  if (!process.env.HAJIMINK_RELEASE_PRIVATE_MARKERS) return [];
  let markers;
  try { markers = JSON.parse(process.env.HAJIMINK_RELEASE_PRIVATE_MARKERS); }
  catch { throw new Error('Invalid private marker configuration'); }
  if (!Array.isArray(markers) || markers.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Invalid private marker configuration');
  return markers;
}
export function inspectText(rel, text, { privateMarkers = [], checkEmail = true } = {}) {
  const issues = [];
  const patterns = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
    ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
    ['cloud credential', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ['personal Windows home', /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/](?!Public\b|<|YOUR_)[^\\/\s"'`]+/g],
  ];
  if (rel.toLowerCase().endsWith('.md')) patterns.push(['absolute Windows path in documentation', /\b[A-Za-z]:[\\/](?!Windows(?:[\\/]|\b))[^\s`"')]+/g]);
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) issues.push(`${rel}:${text.slice(0, match.index).split('\n').length}: ${label}`);
  }
  for (const marker of privateMarkers) {
    const index = text.toLowerCase().indexOf(marker.toLowerCase());
    if (index >= 0) issues.push(`${rel}:${text.slice(0, index).split('\n').length}: private marker`);
  }
  if (checkEmail) {
    for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)) {
      const lineStart = text.lastIndexOf(String.fromCharCode(10), match.index) + 1;
      const lineEnd = text.indexOf(String.fromCharCode(10), match.index);
      const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
      const upstreamDeprecation = rel === 'package-lock.json' && /^\s*"deprecated":/.test(line) && /^i@izs[.]me$/i.test(match[0]);
      if (!upstreamDeprecation && !/(?:^|\.)example\.(?:com|org|net|test|invalid)$/i.test(match[1])) issues.push(`${rel}:${text.slice(0, match.index).split('\n').length}: non-example email address`);
    }
  }
  return issues;
}
export function inspectRelease(root, { privateMarkers = [] } = {}) {
  const files = releaseFiles(root); const issues = [];
  for (const rel of files) {
    if (!extensions.has(path.extname(rel).toLowerCase()) && !rootFiles.has(rel)) issues.push(`${rel}: unsupported source file type`);
    const bytes = fs.readFileSync(path.join(root, rel));
    if (bytes.length > 2 * 1024 * 1024) issues.push(`${rel}: source file is larger than 2 MiB`);
    if (['.png', '.ico'].includes(path.extname(rel).toLowerCase())) continue;
    if (bytes.includes(0)) { issues.push(`${rel}: unexpected binary content`); continue; }
    issues.push(...inspectText(rel, bytes.toString('utf8'), { privateMarkers }));
  }
  if (fs.existsSync(path.join(root, '.git'))) {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
    for (const file of tracked) if (forbidden(file) || !files.includes(file)) issues.push(`${file}: tracked outside the release allowlist`);
  }
  return { files, issues };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const result = inspectRelease(root, { privateMarkers: privateMarkersFromEnv() });
    if (result.issues.length) { console.error(result.issues.join('\n')); process.exitCode = 1; }
    else if (process.argv.includes('--list')) console.log(JSON.stringify({ files: result.files, version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version }));
    else console.log(`PASS release source policy: ${result.files.length} files; no runtime data included`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
