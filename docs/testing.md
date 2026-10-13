# Local Test Tiers and Verification Costs

## Entry points and boundaries

The existing Node test infrastructure is unchanged. `scripts/test.mjs` selects local tests, isolates the environment before imports, and runs tests serially. The counts and costs below are the baseline from the introduction of test tiers (`bf85d3e`): the existing 45 files and 385 tests were retained, with 5 launcher tests added, for a total of 390. Later regression tests do not rewrite historical measurements; use actual execution output for current counts.

| Entry point | Files / tests | Scope |
|---|---:|---|
| `npm run test:fast` | 26 / 239 | Logic, UI, result projections and transcript reading without launching CLIs/Git; temporary file I/O is allowed |
| `npm run test:domain` | 6 / 62 | Single-module protocols/adapters, RPC, storage races, Git workspaces and the test launcher; local fixtures only |
| `npm run test:acceptance:local` | 14 / 89 | Local end-to-end checks for the manager, extension entry points, UI actions, approvals and recovery; CLIs use fixtures |
| `npm test` | 46 / 390 | Union of the three local selections above; excludes real-model acceptance |
| `npm run test:list` | No tests executed | List all local test files and identify real acceptance tests that were not run |

Execution entry points build `dist/` first; `test:list` does not build. With a current build, run `node scripts/test.mjs fast` directly.

File classification is defined in [`scripts/test-tiers.json`](../scripts/test-tiers.json). Every formal `.test.mjs` file must belong to exactly one tier. Duplicates, omissions, missing files and non-test entries fail before test imports rather than being silently skipped.

```bash
# List a tier without executing it
node scripts/test.mjs domain --list

# Run only the specified files in that tier (no implicit fast-tier run)
npm run test:domain -- workspace.test.mjs
npm run test:acceptance:local -- extension.test.mjs tool-receipts.test.mjs
```

Files from other tiers, unknown tiers, arbitrary paths and `real-smoke.mjs` are rejected. Real-model scripts such as `test/real-smoke.mjs` are excluded from these entry points and explicitly reported as **NOT_RUN**. Their existing standalone invocation remains unchanged and still requires explicit user authorization. A local PASS does not establish acceptance of real CLIs, models, OS crashes or the human TUI experience.

## Environment isolation

Each execution creates a temporary `PI_CODING_AGENT_DIR` and applies it before child-process module imports, preventing the user's worker-role configuration from redirecting a Pi fixture to real Codex/Claude. It also clears the inherited `PI_CLI_SUBAGENT` marker so extension registration does not return early. The real child-agent recursion guard remains intact; tests do not disable it.

The Node runner uses `--test-concurrency=1` and does not modify the parent process environment or the user's global configuration. The temporary home is cleaned up on normal completion and failure, preserving the test exit code. This entry point is not an OS sandbox and does not guarantee temporary-directory cleanup after a force kill or power loss.

Launcher tests use independent miniature repositories to verify real process boundaries. Before starting the inner runner, they remove `NODE_TEST_CONTEXT` only in the fixture environment so Node does not mistake it for recursive execution of the outer test and silently skip it.

## 开发 SDK 与安全依赖

开发用的 Pi AI、coding-agent、TUI 三个直接依赖统一固定为 `1.0.1`，运行时 peer 仍为 `*`，不打包宿主副本。它是 `0.87.1` 之后首个显式依赖 `brace-expansion 5.0.12` 的稳定 SDK；更早版本的 shrinkwrap 会把传递依赖恢复为有告警的 `5.0.9`。

仅对 SDK `1.0.1` 的 `pi-codemode` 使用同版本 override：其 `^1.0.1` 范围会解析到移除了 `MCP_TYPESCRIPT_PREAMBLE` 的新版，导致 SDK 导入失败。不能只因 audit 清零就删除这个兼容约束；变更后须验证真实导入和加载器。

升级后用干净的 `npm ci --ignore-scripts` 验证实际安装树与 `npm audit`，不要只检查锁文件字面值。就地升级可能残留旧嵌套依赖；按当前 manifest 重建干净锁后再验收。复用既有隔离解包加载器与本地 worker 夹具，分别检查开发 SDK 和实际宿主；这些 PASS 不代表真实模型验收。

## 角色默认值回显

角色面板只回显未覆盖字段，不加“原生默认”标注，不把回显值写入角色文件。保存其他字段、打开/关闭选择器不会冻结继承；用户明确选中一个值才创建该字段的覆盖。切换 CLI 仍清除旧后端字段，个人草稿即使被项目同名角色遮盖，也按个人草稿的 CLI 显示字段和选择器。

- Pi 回显父会话当前 provider/model/thinking；Codex 用原生 `config/read` 读取当前 cwd 的配置层，不创建 thread/turn。只有审批策略和 sandbox 都匹配时才显示我们的 mode 预设，否则显示原生组合，不静默改成近似权限。
- Claude Code 只读实际 `CLAUDE_CONFIG_DIR`、当前 cwd 的共享/本地 settings 和文件型 managed settings，白名单保留模型/effort 相关环境变量；不读取认证文件、不保留或输出凭证字段，不启动 Claude、不执行 hooks/helpers，不获取账户或服务器管理策略。这是本地配置快照，不是运行中实例的生效值证明。
- 未明确配置或动态模型/权限默认值无法离线确定时显示 `default`，不猜订阅默认模型或固定 effort；读取失败显示 `unavailable`。非 Windows 的 Git 子目录/linked worktree 等无法确定 local settings 路径时也不猜。重新打开面板刷新快照；已有 worker 不热更新。
- 回显中的 `bypassPermissions`、`full-access` 和原生 `never` 审批组合仍保留权限告警。本地 fixture 覆盖来源、父模型、CLI 切换、默认选择定位、同名模型 provider、保存不冻结、重开刷新、关闭/会话切换后的迟到结果；不替代人工 TUI 或真实模型验收。

## /agents 列表与释放

主界面不再安装下方实例快捷选择器，仅保留状态摘要与 `/agents`（Ctrl+Alt+A）。列表先为选中实例保留一行，再计入实际存在的滚动标记；窗口缩放和窄列不能让状态文字挤掉实例身份。

运行图标复用外部状态摘要的同一 80ms 动画帧，不新增计时器或读盘；waiting、idle 和终态保持静态图标。已打开面板接收既有 800ms 监控快照，状态、问题和释放候选随之更新，elapsed 在绘制时计算。更新按实例 ID 保留选中项与同轮详情滚动；新轮清除旧结果滚动，当前详情目标消失时退回列表而不切到另一实例。历史开关保持不变，关闭、执行动作或切换父会话后解除快照回调。用 mock timers 和真实扩展接线验证读取次数、共享帧、状态变化及无迟到重绘。

面板及会话查看器的 `x` 仅释放已知 v2 idle owner，且必须没有待处理请求；`c` 批量释放同类目标。确认前复读状态，执行时传入捕获的 runId/runtimeId 并复用 onlyIdle 准入，拒绝变忙或换代的目标，不重试。执行中的 Pi/Codex 可用 `t` 中断当前轮，之后才可释放；不改变父代理工具的主动 stop 契约。

默认隐藏 manager 查询已确认关闭所有权的 v2 实例（closed + runtimeClosed），不依赖仅存在于操作响应的 receipt。列表按 `h` 查看历史，结果、原生会话恢复和文件均保留；unreachable 或旧版未确认状态不会冒充已释放。

人工操作记录默认一行折叠，使用 Pi 当前展开键查看完整正文。批量成功只弹出释放数量，部分失败仍显示各目标诊断；原正文、outbox、去重及 `triggerTurn:false` 保持不变。覆盖列表边界、历史恢复、忙碌/换代拒绝、真实本地 fixture 释放和无模型消息组件；不替代人工 TUI 与真实模型验收。

## Tier selection rules

1. For everyday changes, run the fast tier and relevant domain files. Changes to shared entry points such as `src/index.ts` or notifications/receipts also need the corresponding local acceptance checks.
2. For native CLI adapter changes, run the relevant adapter domain tests and manager/workspace local acceptance checks. This does not automatically authorize real-model calls.
3. Close-out without CI requires at least the complete fast and domain tiers. Use `npm test` for full local regression after changes to shared schemas, cross-tier contracts or test entry points.
4. Update the manifest before adding tests. Classify by actual dependencies, not filenames. A few mixed-tier files remain, such as `core.test.mjs` and `tool-receipts.test.mjs`; do not refactor their contents just for tiering.
5. Treat 20 seconds of fast-tier wall time as a review threshold, not a failure gate. If exceeded, check machine load, dependencies and tier assignment first; do not remove safety coverage to meet a time or test-count target. Removing or merging tests requires separate counterexample/mutation evidence.

## Cost measurements

These measurements were collected in one run per entry point on 2026-10-08 at `8b958b6` (Windows / Node 22.21.0); each entry point includes one build. All passed with skipped=0; real CLI/model acceptance was NOT_RUN throughout. The counts are the current suite, which is larger than the historical `bf85d3e` baseline in the tables above.

| Entry point | Passed / total | Wall time including build | Node runner time |
|---|---:|---:|---:|
| `npm run test:fast` | 262 / 262 | 20.17 s | 16.09 s |
| `npm run test:domain` | 65 / 65 | 70.72 s | 66.55 s |
| `npm run test:acceptance:local` | 90 / 90 | 179.71 s | 175.25 s |
| `npm test` | 417 / 417 | 248.29 s | 243.99 s |

Tiering reduces the cost of selecting tests for everyday changes; it does not claim to accelerate the full suite. The full-suite 248.29 seconds came from an independent run, not the sum of the three tier times. The fast tier now carries 29 files and 262 tests (the baseline above had 26 and 239), which is why its 20.17 seconds including build sits at the review threshold in rule 5. Local logs are in the ignored `.test-output/tiers-*.log` and `tiers-timings.json`. Remeasure after environment or test changes; this table is not a continuing performance guarantee.
