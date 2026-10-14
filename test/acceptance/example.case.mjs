// Template for a real-acceptance case module. Copy it beside the round's evidence under the
// ignored .test-output/manual-acceptance/<case>/ directory, adjust the library import, and replace
// every placeholder. The values below are placeholders, not real evidence; this file is
// documentation and is never reached by the audit entry point or by npm test.
//
//   node test/acceptance/audit.mjs .test-output/manual-acceptance/<case>/case.mjs
//
// check(ev) asserts one round. Immutable evidence (the parent session, the extension's own records,
// native logs, transcripts) is asserted directly. Mutable artifacts (effect files, child working
// directories, worktrees, Git state) go through ev.effects, which reports "unavailable" rather than
// passing or failing when the artifact has been cleaned up. Two rules keep a replay honest:
//   - Never let a missing artifact pass silently, and never turn "unavailable" into a pass.
//   - Never assert that the session holds no later rows. The parent session is append-only, so a
//     later manual action legitimately appends its own record; scope such claims to the round by
//     comparing row lines against the round's own notices.
import path from 'node:path';
import { ascending } from './evidence.mjs'; // real cases under .test-output use '../../../test/acceptance/evidence.mjs'

const SESSION_FILE = '<parent session jsonl: <agent dir>/sessions/<project>/<timestamp>_<id>.jsonl>';
const CHILD_CWD = '<the child working directory this round must have used>';
const CMD = '<the single command or action this round was authorized to perform>';

export default {
  name: '<case name, e.g. b-codex-2026-01-01 (Codex approve path)>',
  session: SESSION_FILE,
  check(ev) {
    const { assert } = ev;

    // Parent session: one dispatched task, one decision, the expected notices.
    assert.equal(ev.users.length, 1);
    assert(ev.textOf(ev.users[0]).includes(CMD));
    const start = ev.one('subagent', 'start');
    assert.equal(start.arguments.cwd, CHILD_CWD);
    const reply = ev.one('subagent_reply');
    assert(reply.arguments.reason.startsWith('<authorization reason prefix>'));
    assert.equal(ev.notices.length, 2, 'one waiting notice and one completion notice');

    // Agent record: the frozen spec, the terminal state and the permission audit entry.
    const agent = ev.only();
    assert.equal(agent.state.questions.length, 0);
    const runId = agent.runIds[0];
    const run = agent.run(runId);
    assert.equal(run.permissions.length, 1);
    assert.deepEqual(
      { actor: run.permissions[0].actor, decision: run.permissions[0].decision, questionId: run.permissions[0].questionId },
      { actor: 'parent', decision: 'answered', questionId: reply.arguments.questionId });
    const result = agent.result(runId);
    assert.equal(result.status, 'completed');
    assert.equal(path.normalize(result.parentFile), path.normalize(SESSION_FILE));

    // Native evidence: assert the backend's own request/response and terminal record, e.g.
    //   const events = agent.events();
    //   const request = events.find(row => row.type === 'control_request');
    // Keep the backend-specific shapes here rather than in the shared library.

    // Mutable artifacts: report unavailable instead of passing when they have been cleaned up.
    ev.effects.emptyDir(CHILD_CWD);
    ev.effects.equals(path.join(CHILD_CWD, '<effect file>'), '<expected content>', { size: 0 });

    // Release: the round is over, so the terminal snapshot must show no live owner.
    const release = agent.release();
    assert.equal(release.ownerLock, false);
    assert.equal(release.workerLive, false);
    assert.equal(release.cliLive, false);

    // Timing: the recorded marks must not run backwards.
    ascending([['start', agent.state.startedAt], ['resultReport', result.time]]);
  },
  // Optional: the facts a reader should not have to dig for.
  summary(ev) {
    const agent = ev.agents.get(ev.agentIds[0]);
    return { agentId: ev.agentIds[0], runId: agent.state.runId, finalText: agent.result(agent.state.runId).text };
  },
};
