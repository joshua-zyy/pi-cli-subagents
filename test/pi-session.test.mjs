import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { inspectPiSession } from '../dist/pi-adapter.js';
import { tempDir } from './helpers/tmp.mjs';

function setup(t) {
  const dir = tempDir('pi-session');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {sessionFile:path.join(dir,'session.jsonl'),sessionId:'original'};
}
const header = (id = 'original') => JSON.stringify({type:'session',version:3,id,cwd:'/fixture'});

test('Pi preflight reads native headers without rewriting legacy, CRLF, or unterminated files', async t => {
  const session = setup(t);
  for (const content of [header(), `${header()}\r\n`, '{"type":"session","id":"original"}\n',
    `\n{broken\nnull\n${header()}\n{"type":"message","id":"other"}\n`]) {
    fs.writeFileSync(session.sessionFile,content);
    await inspectPiSession(session);
    assert.equal(fs.readFileSync(session.sessionFile,'utf8'),content,'inspection must neither migrate nor append a newline');
  }
  const prefix = '{"type":"session","padding":"', suffix = '","id":"';
  const content = prefix + 'x'.repeat(4095 - prefix.length - suffix.length) + suffix + '会话🙂"}\n';
  fs.writeFileSync(session.sessionFile,content);
  await inspectPiSession({...session,sessionId:'会话🙂'});
  assert.equal(fs.readFileSync(session.sessionFile,'utf8'),content,'UTF-8 identity spanning read chunks is preserved');
});

test('Pi preflight refuses foreign, missing and invalid first entries instead of searching for a later matching header', async t => {
  const session = setup(t);
  await assert.rejects(inspectPiSession(session),/ENOENT/);
  for (const content of ['', '{broken\n', header('foreign'), '{"type":"session","id":42}',
    '{"type":"session"}', `{"type":"message","id":"original"}\n${header()}\n`]) {
    fs.writeFileSync(session.sessionFile,content);
    await assert.rejects(inspectPiSession(session),/header|different session/i);
    assert.equal(fs.readFileSync(session.sessionFile,'utf8'),content);
  }
});

test('Pi header inspection bounds I/O and releases read-only handles on success, scan limits and read failures', async t => {
  const session = setup(t), open = fsp.open;
  let bytes = 0, closed = 0, failRead = false;
  const mocked = t.mock.method(fsp,'open',async (file,flags)=>{
    assert.equal(flags,'r');
    const handle = await open(file,flags);
    return {async read(...args){
      if (failRead) throw Object.assign(Error('fixture read denied'),{code:'EACCES'});
      const result = await handle.read(...args); bytes += result.bytesRead; return result;
    },async close(){closed++;await handle.close();}};
  });
  syncBuiltinESMExports();
  t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});

  const fd = fs.openSync(session.sessionFile,'w');
  fs.ftruncateSync(fd,32 * 1024 * 1024); fs.writeSync(fd,`${header()}\n`,0,'utf8'); fs.closeSync(fd);
  await inspectPiSession(session);
  assert.ok(bytes <= 4096,'do not scan a large transcript after finding the header');
  assert.equal(closed,1);

  const limit = 1024 * 1024;
  const exact = header().slice(0,-1) + ',"padding":"' + 'x'.repeat(limit - header().length - 13) + '"}';
  assert.equal(Buffer.byteLength(exact),limit);
  fs.writeFileSync(session.sessionFile,exact);
  await inspectPiSession(session); // Exactly at the limit, without a final newline.
  assert.equal(closed,2);
  for (const content of [exact + ' ', '\n'.repeat(limit) + header()]) {
    fs.writeFileSync(session.sessionFile,content); bytes = 0;
    await assert.rejects(inspectPiSession(session),/scan limit/i);
    assert.ok(bytes <= limit + 1);
  }
  assert.equal(closed,4);
  failRead = true;
  await assert.rejects(inspectPiSession(session),{code:'EACCES',message:'fixture read denied'});
  assert.equal(closed,5,'read errors do not leak native session handles');
});
