import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTempFixture } from './safe-temp';

it('removes only a verified temporary fixture and rejects the temporary root or a mismatched name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-safe-temp-'));
  expect(() => removeTempFixture(os.tmpdir(), 'hajimink-safe-temp-')).toThrow('Unexpected test directory');
  expect(() => removeTempFixture(dir, 'not-the-fixture-')).toThrow('Unexpected test directory');
  expect(fs.existsSync(dir)).toBe(true);
  removeTempFixture(dir, 'hajimink-safe-temp-');
  expect(fs.existsSync(dir)).toBe(false);
});
