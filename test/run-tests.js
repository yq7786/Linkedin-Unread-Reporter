import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const entries = await fs.readdir(testDirectory, { withFileTypes: true });
let failed = false;

for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
  if (!entry.isFile() || !entry.name.endsWith('.test.js')) continue;
  const result = spawnSync(process.execPath, [path.join(testDirectory, entry.name)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) failed = true;
}

if (failed) process.exitCode = 1;
