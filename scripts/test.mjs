import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length > 2) throw new Error('This entry accepts no arguments');
const files = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.mjs')).sort();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-subagents-tests-'));
const env = { ...process.env, PI_CODING_AGENT_DIR: home };
delete env.PI_CLI_SUBAGENT;
try {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files.map(name => path.join(root, 'test', name))], {
    cwd: root, env, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
