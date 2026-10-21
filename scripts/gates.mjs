// One build for the whole gate sweep, then each tier in order. Every gate runs even when an earlier
// one fails, so a single pass reports all failures; the exit code is non-zero if any tier failed.
// `node scripts/gates.mjs` covers check + fast + domain + acceptance-local.
// `node scripts/gates.mjs --slow` adds acceptance-slow (the heavy local-process files).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const slow = process.argv.includes('--slow');
const tiers = ['fast', 'domain', 'acceptance-local', ...(slow ? ['acceptance-slow'] : [])];

const run = (label, args) => {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false });
  return { label, code: result.status ?? 1, ms: Date.now() - started };
};

const script = (name) => path.join(root, 'scripts', name);
const results = [];
results.push(run('check', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit']));
// prepack and the tier entries both rebuild dist; build once here so every tier measures the same tree.
const build = run('build', [script('build.mjs')]);
results.push(build);
if (build.code === 0) for (const tier of tiers) results.push(run(tier, [script('test.mjs'), tier]));

const failed = results.filter(r => r.code !== 0);
console.log('\nGate summary');
for (const r of results) console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.label.padEnd(16)} ${(r.ms / 1000).toFixed(1)}s`);
console.log(`  tiers: ${tiers.join(', ')}${slow ? '' : ' (add --slow for acceptance-slow)'}`);
console.log('  real CLI/model acceptance is NOT_RUN; it needs separate authorization.');
if (failed.length) {
  console.log(`\n${failed.length} gate(s) failed: ${failed.map(r => r.label).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nall gates passed');
}
