import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Remove only a known fixture directory that resolves directly inside the OS temp directory. */
export function removeTempFixture(directory: string, prefix: string) {
  const actual = fs.realpathSync(directory);
  const root = fs.realpathSync(os.tmpdir());
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(path.dirname(actual)) !== normalize(root) || !path.basename(actual).startsWith(prefix)) throw new Error('Unexpected test directory');
  fs.rmSync(actual, { recursive: true, force: true });
}
