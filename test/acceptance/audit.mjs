// Entry point for the read-only real-acceptance auditor. It loads one case module and reports a
// verdict. The readers and assertion helpers live in evidence.mjs, which holds no top-level await,
// so a case module that imports it does not re-enter this entry point.
//
//   node test/acceptance/audit.mjs <case-module.mjs>
//
// A case module default-exports { name, session, check(ev) }. It starts no model, CLI or RPC,
// executes no case command and rewrites nothing; the verdict covers the immutable evidence and
// lists the mutable artifacts that could not be checked.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEvidence } from './evidence.mjs';

const target = process.argv[2];
if (!target) { console.error('usage: node test/acceptance/audit.mjs <case-module.mjs>'); process.exit(2); }
const { default: round } = await import(pathToFileURL(path.resolve(target)).href);
const ev = loadEvidence(round.session);
try {
  round.check(ev);
  const unavailable = ev.effects.unavailable;
  console.log(JSON.stringify({ audit: 'PASS', case: round.name, effectsChecked: ev.effects.checked, effectsUnavailable: unavailable.length, unavailable, ...(round.summary ? { summary: round.summary(ev) } : {}) }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ audit: 'FAIL', case: round.name, message: error.message, where: String(error.stack).split('\n').slice(1, 5) }, null, 2));
  process.exitCode = 1;
}
