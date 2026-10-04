import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const [tier = 'all', ...args] = process.argv.slice(2);
let tiers;
try {
  tiers = JSON.parse(fs.readFileSync(new URL('./test-tiers.json', import.meta.url), 'utf8'));
} catch (error) {
  throw new Error('Cannot read test tier manifest', { cause: error });
}
const keys = ['fast', 'domain', 'acceptance-local'];
if (!['all', ...keys].includes(tier)) throw new Error(`Unknown tier: ${tier}`);
if (!tiers || Object.keys(tiers).sort().join() !== [...keys].sort().join()) throw new Error('Invalid tier manifest');
const local = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.mjs')).sort();
const classified = new Set();
for (const key of keys) {
  if (!Array.isArray(tiers[key])) throw new Error(`Invalid tier: ${key}`);
  for (const file of tiers[key]) {
    if (typeof file !== 'string' || !/^[a-z][a-z0-9-]*\.test\.mjs$/.test(file)) throw new Error(`Invalid local test entry: ${file}`);
    if (classified.has(file)) throw new Error(`Duplicate test entry: ${file}`);
    if (!local.includes(file)) throw new Error(`Missing test file: ${file}`);
    classified.add(file);
  }
}
const unclassified = local.filter(file => !classified.has(file));
if (unclassified.length) throw new Error(`Unclassified local tests: ${unclassified.join(', ')}`);
const available = tier === 'all' ? local : [...tiers[tier]].sort();
const requested = args.filter(arg => arg !== '--list');
for (const file of requested) if (!available.includes(file)) throw new Error(`File not selected by ${tier}: ${file}`);
const files = requested.length ? [...new Set(requested)].sort() : available;
if (!files.length) throw new Error(`No tests selected by ${tier}`);
const notRun = 'Real CLI/model acceptance is NOT_RUN; it requires separate explicit authorization.';
if (args.includes('--list')) {
  console.log(JSON.stringify({ tier, files, notRun }, null, 2));
  process.exit(0);
}
console.log(`Local tests: ${tier}; selected ${files.length}/${local.length} files. ${notRun}`);
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
