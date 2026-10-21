// Shared build entry for npm and the gate sweep; never invoke a shell or PATH shim.
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
rmSync(path.join(root, 'dist'), { recursive: true, force: true });
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
  cwd: root, stdio: 'inherit', shell: false,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
