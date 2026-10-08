// Scratch directories for local tests: created under .test-output and deleted when the test process exits.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.test-output');
const created = [];
let installed = false;

/** Windows keeps read-only files (Git objects, lock files) alive through rmSync until the attribute is cleared. */
function wipe(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    return;
  } catch {}
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    try {
      fs.chmodSync(path.join(dir, entry), 0o666);
    } catch {}
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch {}
}

/** A disposable directory for one test case. Best-effort removal keeps a locked directory instead of failing the run. */
export function tempDir(prefix) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, `${prefix}-`));
  created.push(dir);
  if (!installed) {
    installed = true;
    process.on('exit', () => {
      for (const dir of created) wipe(dir);
    });
  }
  return dir;
}
