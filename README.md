# pi-cli-subagents

[Chinese README](README.zh-CN.md)

Delegate work from Pi to **reusable Pi, Codex, and Claude Code sessions**. Run independent tasks concurrently, receive completion reports automatically, and continue with the same agent for follow-up work. Optional Git worktrees keep parallel edits separate.

## Quick start

Requires Node.js **>=22.19** and a configured Pi CLI. Install and authenticate Codex or Claude Code separately if you want to use them.

```bash
# In this extension's directory
npm ci
npm run build

# In the project where you want to use it
pi install --local /absolute/path/to/pi-cli-subagents
pi
```

The local install adds the extension and bundled skill to `.pi/settings.json`; review the project trust prompt yourself. For a one-off run without changing settings:

```bash
pi --extension /absolute/path/to/pi-cli-subagents/dist/index.js \
   --skill /absolute/path/to/pi-cli-subagents/skills/delegate-cli-agents
```

Ask Pi, for example:

> Have the configured worker investigate and fix this test in an isolated worktree, and report the result.

Roles, task decomposition and review policy are yours to configure; the extension does not impose an agent workflow.

Use a persistent parent session, **not `--no-session`**. Reports arrive automatically; do not poll for completion. A running child can continue after the parent exits; reopen the **original parent session** to receive its pending reports.

## Roles and models

All four built-in roles use Pi: `explore` investigates, `worker` implements and verifies, `reviewer` independently reviews, and `oracle` gives a second opinion. Read-only role instructions are **not a permission sandbox**.

Open **`/cli-agents-setting`** to choose each role's CLI and model. **Tab** switches user/project scope, **Enter** edits, **s** saves, and **Esc** goes back one level or closes the role list (asking before discarding an unsaved draft). Selected roles, fields, and choices stay visible in short panels. Changes apply to the next spawn.

You can also edit role files directly:

- User: `~/.pi/agent/cli-subagents.roles.json`
- Trusted project: `.pi/cli-subagents.roles.json`

Precedence is **project > user > built-in**. Each entry replaces the whole role; `description` and `instructions` are required. For example, move only the reviewer to Codex (replace the model placeholder):

```json
{
  "reviewer": {
    "cli": "codex",
    "description": "Review changes independently",
    "instructions": "Inspect the assigned changes without editing files. Report issues with evidence and state what you verified.",
    "model": "YOUR_AVAILABLE_CODEX_MODEL",
    "effort": "high",
    "mode": "read-only"
  }
}
```

| CLI | Model settings | Permission setting (`mode`) |
| --- | --- | --- |
| Pi | `provider`, `model`, `thinking`; omitted values follow the parent at launch | Not supported |
| Codex | Required `model`; optional `effort` supported by that model | `read-only`, `workspace-write`, `full-access` |
| Claude Code | Optional `model` and `thinking` (passed as `--effort`) | `manual`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` |

These are per-launch settings, not changes to the CLIs' global configuration. Codex/Claude use native defaults for omitted optional settings. **Do not assume approval prompts will appear:** `dontAsk`, `bypassPermissions`, and `full-access` suppress them, with different denial/permission behavior. Leave `mode` unset unless you deliberately want to override the native posture.

**Codex Default-mode questions (experimental):** the Codex-only role field `defaultModeQuestions` has three states, also selectable in `/cli-agents-setting`:

- `true`: enable with the process argument `-c features.default_mode_request_user_input=true`.
- `false`: explicitly disable Default-mode questions with the same argument set to `false`. Plan-mode questions are unaffected.
- Omitted (UI: `inherit`): send no override; inherit native Codex configuration. In CLI 0.159.2 this feature is under development and defaults to off.

For example, add `"defaultModeQuestions": true` to an existing Codex role to opt in. This does not switch collaboration mode, alter `model`/`effort`/approval/sandbox settings, or write global configuration. It does not override the separate `tools.experimental_request_user_input.enabled` tool-registration setting (enabled by default in 0.159.2). Role edits apply to **new instances**; existing instances retain their saved role on resume and cannot gain this override through a later role edit. If the native tool is still unavailable, inspect the actual CLI version and configuration rather than changing permission mode or silently retrying. Remove this field before downgrading or sharing role files with older extension versions: an unknown field causes rejection of the whole role file.

## Monitor and continue

Open **`/agents`** or press **Ctrl+Alt+A**. Select an instance with **↑/↓**; use **Enter/v** for its live conversation, **s** to message or resume, **r** to answer a request, and **x** to stop. Closing the viewer does not stop the agent. On first open the viewer reads one bounded tail window and afterwards only follows bytes appended to it; scrolling upward (**PgUp**, **↑**) within about two screens of the loaded top prefetches an older page while preserving your reading position; **Home** triggers it directly. Upward movement requested during loading is applied when the page arrives, with same-direction requests coalesced and no accidental reverse paging. **End** supersedes pending upward movement. Each disk page keeps at most 300 entries. A separate display list retains up to 1200 entries with an 8 MiB text-and-key budget, rather than being replaced wholesale by the next disk window. Eviction prefers non-visible content opposite the navigation direction, never the entries being read. Visible content is held while paused; returning to the end publishes the latest already-read values. History still reaches the oldest records step by step and can be walked back down; **End** re-anchors at the live end. Reopening the same agent in this process reuses the paged window, so a window left on an old page stays there until you press **End**, while a replaced or truncated log drops it. Whole-log token totals appear only when the loaded window really covered every run; otherwise the header says **Stats incomplete** instead of showing a partial number. Status, scrolling, and message/stop controls remain available throughout, and event logs are never modified.

The viewer draws on [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)’ conversation-list, scroll-offset and auto-follow model, measuring current content on every navigation key. This project additionally adapts on-demand logs from independent CLIs rather than directly holding an SDK `session.messages` array.

Tools in the live viewer default to one-line summaries, including failures (marked with `✗`). **Ctrl+O** toggles all loaded tool inputs and outputs in this viewer only; it follows the host’s `app.tools.expand` binding, including remapping or disabling it. Expansion survives live updates, while **Enter** still opens the message composer. Long content remains subject to the existing reader limits and clipping notices; original logs are unchanged.

| Tool available to the parent | Purpose |
| --- | --- |
| `subagent` | `start` a configured role, `send` to an existing instance, or `stop` active work |
| `subagent_query` | `list` metadata/workspaces, `get` instance details, or read an exact run with `result` |
| `subagent_reply` | Answer one current request with an explicit reason |
| `subagent_workspace` | Explicitly `create` a managed worktree or `integrate` its pending changes |

`subagent_query({action: "list"})` returns metadata without result bodies; `{action: "get", id}` adds the current bounded preview. Final notifications include a `subagent_query({action: "result", id, runId})` link to the original result for that exact run. For longer results, keep both IDs fixed and pass the returned `nextOffset` as `offset` until it is `null` (default/max `limit: 6000` UTF-16 code units). Reading results never resumes an agent.

In the TUI, reports follow Pi’s expand/collapse state (**Ctrl+O** by default, respecting custom keybindings). Collapsed cards show a one-line instance/status summary, with failures and pending requests highlighted; expand to see the notification body and exact-run result link. Old notifications without display metadata show `status unavailable` rather than an inferred success. Pending requests stay visible in a status line until answered. Routine requests show “waiting for parent review” without asking you to take over; requests that require human approval instead show an action link and one warning notice. Only presentation changes: parent-facing content and delivery receipts remain intact. Expanded text strips ANSI/terminal controls; original records are unchanged.

A waiting request reaches a busy parent through `steer`, before its next model request without aborting an in-flight tool. Other notification batches remain `followUp` messages, delivered when the parent finishes its current execution. The parent handles both task questions and permission requests itself; it escalates when context, effects or authorization are unclear, the user explicitly requires confirmation, or the native request requires a human.

Pi children explicitly load the bundled `subagent_ask_parent` tool on each start or resume; no global plugin installation is needed. Its recognized call becomes one logical task question with 2–4 choices and custom text. Submit an offered label or your custom answer once as `subagent_reply.value`. Following Paseo’s flow, the adapter caches the answer and automatically replies to the matching native selection and input; the parent does not handle a second UI step or send another prompt. These requests carry `kind: "question"` and `parentPolicy.text: true`; answers are context, not permission grants. Native dialogs are consumed only when their call, versioned title and expected UI stage/shape match. Other Pi `select`/`confirm`/`input`/`editor` dialogs are forwarded separately to the parent with their native choices or text shape; they never consume a cached task answer. No button-label whitelist decides whether the parent may reply.

Codex task forms (`requestUserInput`, checked against CLI 0.159.2) can contain multiple questions. For `method: "form"` with `parentPolicy.answers: true`, read `fields` via `subagent_query get` and submit one `subagent_reply.answers` object: `{ "<field-id>": ["exact answer"] }` for every field. Respect choices and `allowOther`; `[]` explicitly skips a field, while `cancelled: true` dismisses the whole form. Missing fields are rejected, never filled with a guessed first option. Non-blocking forms keep the child running, but answers remain bound to the original request and turn; resolved, ended or uncertain deliveries must not be replayed.

Codex treats these answers as trusted user input, so provide only already-authorized task context, never new authorization. A recognized `mcp_tool_call_approval_<callId>` request bound to a live MCP action is a separate single-call permission: use `subagent_reply.value: "Allow"` or `"Cancel"` (or `cancelled: true`), never `answers`. Only these two choices are exposed, even if native persistent options exist. The separate `mcpServer/elicitation/request` entry is supported only for explicit MCP-approval metadata, a message-only form, and one unambiguously associated live call: reply with `confirmed: true` (accept), `confirmed: false` (decline), or `cancelled: true` (cancel), never form answers or persistent grants. Unknown kinds, data/URL forms and uncorrelated requests fail closed. The host-reserved `mcp_tool_call_approval*` IDs must not be used for task questions. Human form entry is available through `/agent-reply`; sensitive fields warn that input is visible and may be retained in logs, not masked.

Claude's built-in `AskUserQuestion` (checked against 2.1.283) uses the same `answers` interface for 1–4 choice, text or number questions. Text/number cards require the native extended-question feature; this extension does not enable it. Its field IDs are the **full question text**, not display headers. `multiSelect: false` accepts at most one string; `true` accepts multiple selections plus one custom answer. `[]` skips a field without guessing a default. The native `requires_user_interaction: true` flag is satisfied only by this decoded question card, never by a blanket approval; explicit native human-only restrictions still apply. Cancellation denies the question without interrupting the whole turn. Answers provide task context, not new authorization or persistent permissions.

Human entry collects the whole form before sending one reply. Multi-select menus toggle choices and require **Finish selection**; cancelling any entry discards the partial form. Previews are shown as plain text, not rendered HTML, and display controls are escaped without changing native answer data. Number/text hints are displayed without coercion or applying defaults. Claude question mapping is verified offline; a real Claude model round trip is a separate, explicitly authorized acceptance gate.

Pi and Codex accept running `steer` messages; running `followUp` is Pi-only. Wait for Claude to finish before sending more instructions. Panels are TUI-only; the tools also work in RPC/non-interactive modes.

## Isolate parallel edits

Ask Pi to use **one managed workspace per independently integrable change**:

1. `subagent_workspace({action: "create"})` creates a detached worktree from committed HEAD. Dirty parent files are reported, **not inherited**; inheriting them requires inspection and explicit authorization via `includeUncommitted`.
2. Use `subagent({action: "start", role, task, workspace})`. Different workspaces may run concurrently; one workspace permits one active instance at a time and can be reused after release.
3. Use `subagent_workspace({action: "integrate", workspace})` when appropriate for your workflow. The extension checks technical safety, not whether a particular review procedure was followed.
4. To continue after integration or another instance's sync, explicitly choose `baseline: "keep"` (current workspace files) or `"sync"` (update from the parent). Sync refuses unintegrated or staged work; later integration applies only the new increment.

Integration leaves the parent's HEAD, index, and branches unchanged. Worktrees live under `<repo>.worktrees/`; dependencies and trust are not set up automatically. Shared `cwd` sessions do **not** isolate files, and worktrees do **not** isolate OS permissions.

Managed workspaces require Git with `check-attr --source` (tested on 2.50.1). Sparse checkouts, unmerged indexes, submodules, symlinks, and content filters such as Git LFS are refused. Cleanup is manual and requires authorization; inspect the worktree before removing it, and do not force removal to bypass a refusal.

## Safety and limitations

- **Parent review is not automatic approval.** The parent must stay within the user's authorization and must not grant session-wide or persistent permissions. Pi dialogs expose native responses without proving their effects: `parentPolicy` is a transport constraint, not an authorization verdict, and `confirmed: true` is not necessarily a one-action grant. No hard button-label filter enforces the parent's judgment for arbitrary Pi extensions. Claude/Codex single-action mappings and native human-only restrictions remain enforced. Legacy records without a policy remain refusal-only for the parent. The panel and `/agent-reply <agentId> <questionId>` remain available for human intervention; delivery is not proof of execution.
- **Conflicts are checked before integration writes**, but crashes or I/O failures can leave partial changes. Inspect retained patches, backups, and unfinished journals before retrying. Stale locks and crashed execution owners are not recovered automatically; pause external writers during snapshot/integration/sync.
- **Local records can contain sensitive source data.** Sessions, logs, snapshots, and backups live beside the parent session in `<parent-session-file>.subagents/` and are not deleted when an instance closes.
- **Compatibility has limits.** Pi is the primary end-to-end tested workflow. Codex protocol checks used CLI 0.159.2; Claude requires native Claude Code >=2.1.283 on PATH (`claude.exe` on Windows). Real-parent Pi → Codex/Claude orchestration, live TUI approval/baseline dialogs, and arbitrary crash recovery are not fully verified.

## Development

```bash
npm run check   # TypeScript check
npm test        # Build + all local tiers; no model calls
npm run test:fast
npm run test:domain
npm run test:acceptance:local
npm run test:list # List the local selection without building/running it
```

Test entries isolate user role configuration and clear the inherited child marker before imports, then run serially. For a focused domain check: `npm run test:domain -- workspace.test.mjs`. See [test tiers and verification costs](docs/testing.md) for selection rules, local-only boundaries and measured timings.

After code changes, rebuild and run `/reload` in Pi. Automated tests are not full terminal acceptance. Routine calls are documented by the tools; see the [operational reference](skills/delegate-cli-agents/SKILL.md) for approvals, results, workspaces and recovery. Historical notifications and saved sessions are not rewritten; use their original instance/run IDs with the new query tool.

## Credits

- [Paseo](https://github.com/getpaseo/paseo): lifecycle design, plus Pi logical-question normalization, tool-call/dialog correlation and cached answer replay adapted from its [pinned mapper](https://github.com/getpaseo/paseo/blob/99fc204c55c8c1666477282eeba562ba87a3135f/packages/server/src/server/agent/providers/pi/extensions/rpiv-ask-user-question/index.ts) (Apache-2.0). Codex question normalization and answer mapping are also adapted from its [pinned Codex adapter](https://github.com/getpaseo/paseo/blob/06fe97c9019c1db4a5264dfb9b369b93e5e2fba4/packages/server/src/server/agent/providers/codex-app-server-agent.ts), with ID-keyed answers, stricter validation and no default-choice fallback.
- [Lody Codex ACP](https://github.com/LodyAI/acp-extension-codex/blob/60f1dc4bda7d503eb107a9875893a62d399fd97e/src/permissions/mcp.ts): single-action versus persistent permission separation and [message-only elicitation identification](https://github.com/LodyAI/acp-extension-codex/blob/60f1dc4bda7d503eb107a9875893a62d399fd97e/src/CodexElicitationHandler.ts#L361) (Apache-2.0), adapted to the [OpenAI Codex rust-v0.159.2 MCP question/elicitation contracts](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/mcp_tool_call.rs#L1460). This port binds the request to a live native action and exposes no persistent grants; it does not bundle Lody or its ACP runtime.
- [@juicesharp/rpiv-ask-user-question 2.12.0](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question/v/2.12.0): the single-question RPC choice/custom-answer flow used by the bundled child tool (MIT).
- [pi-subagents](https://github.com/tintinweb/pi-subagents): inspiration for the status and conversation UI.

<details>
<summary>Copyright and license texts for the adapted code</summary>

The following notices apply to the adapted code from the named projects. Modification notes are retained in the relevant source files.

### rpiv-ask-user-question

MIT License

Copyright (c) 2026 juicesharp

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Lody Codex ACP permission policy

Copyright 2025 JetBrains s.r.o.

The adapted permission policy retains the upstream Apache-2.0 license (full text below). Its legacy-question correlation and restricted response mapping are modified for this extension; source pointers and modification notes are retained in `src/codex-mcp-approval.ts`.

### Paseo

Copyright (c) 2025-present Mohamed Boudra

Portions of this software are licensed as follows:

* Third-party components incorporated into Paseo remain licensed under
  the licenses provided by their respective copyright holders.
* Except for those third-party components, Paseo is licensed under the
  Apache License, Version 2.0, reproduced below.


                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

</details>
