// Windows-specific robustness: state.json is rewritten while the parent polls it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeJson } from '../dist/storage.js';

const root = path.resolve('.test-output'); fs.mkdirSync(root, { recursive: true });

test('atomic writes survive a concurrent reader instead of losing state to a Windows rename conflict', { timeout: 30_000 }, async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(root, 'write-race-')), 'state.json');
  fs.writeFileSync(file, '{}\n');
  const reader = spawn(process.execPath, ['--input-type=module', '-e',
    `import fs from 'node:fs';const end=Date.now()+2500;while(Date.now()<end){try{fs.readFileSync(${JSON.stringify(file)},'utf8')}catch{}}`], { stdio: 'ignore' });
  t.after(() => reader.kill());
  let failures = 0;
  for (let index = 0; index < 300; index++) {
    try { writeJson(file, { index, pad: 'x'.repeat(2000) }); } catch { failures += 1; }
  }
  assert.equal(failures, 0, 'a concurrent read must not lose a state write');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).index, 299);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json'], 'no temporary files may be left behind');
});
