// Real OS processes and private heartbeat channels; no agent CLI or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../dist/process-tree.js';
import { waitUntil } from '../dist/storage.js';

async function tree(t, mode) {
  const token = randomUUID(), members = new Map(), sockets = new Set(), handles = [];
  const wait = (check, label, timeout = 5000) => waitUntil(label, () => check() || undefined, timeout);
  const server = net.createServer(socket => {
    sockets.add(socket);
    let buffer = '', member;
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); if (member) member.closed = true; });
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const row = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (row.token !== token) { socket.destroy(); return; }
        if (!member) {
          member = { role: row.role, pid: row.pid, ppid: row.ppid, sequence: 0, closed: false, socket };
          members.set(row.role, member);
        }
        member.sequence = row.sequence;
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    try {
      for (const member of members.values()) if (!member.closed)
        member.socket.write(JSON.stringify({ type: 'exit', token }) + '\n');
      await wait(() => [...members.values()].every(m => m.closed) && handles.every(h => h.closed), 'private fixture cleanup');
    } finally {
      // Only owned handles: no numeric-PID or process-name cleanup on a failed assertion.
      for (const handle of handles) if (!handle.closed) handle.child.kill('SIGKILL');
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
  function start(role) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/process-tree.mjs', import.meta.url)), role, String(server.address().port), token, mode], {
      stdio: 'ignore', shell: false, windowsHide: true, detached: process.platform !== 'win32',
    });
    const handle = { child, closed: false }; handles.push(handle);
    child.once('close', () => { handle.closed = true; });
    child.once('error', () => {});
    return handle;
  }
  const root = start('root'), unrelated = start('unrelated');
  await wait(() => members.size === 4 && [...members.values()].every(m => m.sequence >= 3), 'four live fixture heartbeats');
  assert.equal(members.get('root').pid, root.child.pid);
  assert.equal(members.get('unrelated').pid, unrelated.child.pid);
  assert.equal(members.get('tool').ppid, root.child.pid);
  assert.equal(members.get('leaf').ppid, members.get('tool').pid);
  return { root, unrelated, members, wait };
}

for (const mode of ['ordinary', 'detached']) {
  test(`force cleanup stops ${mode} tool descendants without killing an unrelated process`, {
    skip: mode === 'detached' && process.platform === 'win32', timeout: 15000,
  }, async t => {
    const { root, unrelated, members, wait } = await tree(t, mode);
    await killProcessTree(root.child);
    await wait(() => root.closed, 'original root close');
    const controlSequence = members.get('unrelated').sequence;
    await wait(() => members.get('unrelated').sequence >= controlSequence + 3, 'unrelated process still working after root close');
    assert.equal(unrelated.closed, false, 'unrelated original process must survive');
    assert.equal(members.get('unrelated').closed, false);
    const leaf = members.get('leaf'), sequence = leaf.sequence;
    // A survivor must produce new work, not just leave an old PID or heartbeat file behind.
    if (!leaf.closed) await wait(() => leaf.closed || leaf.sequence >= sequence + 3, 'leaf close or post-root heartbeat');
    assert.deepEqual(['root', 'tool', 'leaf'].filter(role => !members.get(role).closed), [], 'tool descendants must stop, not just the root');
  });
}
