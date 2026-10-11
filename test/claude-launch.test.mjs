import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { claudeEnvironment } from '../dist/claude-launch.js';

const defaultHome = path.join(os.homedir(), '.claude');

test('Claude child environment inherits the user config-dir resolution and pins only a differing home', () => {
  const plain = { PATH: 'x' };
  assert.equal(claudeEnvironment(defaultHome, plain), plain, 'default home with no variable: inherit untouched');
  assert.equal(claudeEnvironment(defaultHome + path.sep, plain), plain, 'path normalization does not force a pin');
  const custom = path.join(os.tmpdir(), 'claude-home-a');
  const withVar = { PATH: 'x', CLAUDE_CONFIG_DIR: custom };
  assert.equal(claudeEnvironment(custom, withVar), withVar, 'matching variable: inherit untouched');
  assert.deepEqual(claudeEnvironment(custom, plain), { ...plain, CLAUDE_CONFIG_DIR: custom }, 'a recorded home that differs is pinned explicitly');
  const other = path.join(os.tmpdir(), 'claude-home-b');
  assert.deepEqual(claudeEnvironment(other, withVar), { ...withVar, CLAUDE_CONFIG_DIR: other }, 'a recorded home overrides a different inherited variable');
  assert.equal(claudeEnvironment(defaultHome, withVar).CLAUDE_CONFIG_DIR, defaultHome, 'the default home is pinned when the inherited variable points elsewhere');
});
