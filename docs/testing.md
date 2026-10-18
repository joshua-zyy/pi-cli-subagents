# Local Test Tiers and Verification Costs

问题、尝试过的方法、对应分支、失败证据和当前结论统一维护在插件迭代记录（本地保留，不进仓库、不随包发布）；本页保留测试入口、分层与验证边界。

## Entry points and boundaries

复用现有 Node 测试入口；`scripts/test.mjs` 在导入前隔离环境并按文件串行执行。当前有四层，精确文件集合以 manifest 为准，测试数量与耗时以当次输出为准。

| 入口 | 范围 |
|---|---|
| `npm run test:fast` | 纯逻辑、UI 与转录投影，允许临时文件 I/O，不启动 CLI/Git |
| `npm run test:domain` | 协议、adapter、存储和 Git 工作区，使用本地替身 |
| `npm run test:acceptance:local` | manager、扩展入口、UI、审批和恢复的本地闭环 |
| `npm run test:acceptance:slow` | manager、驻留和工作区的重型本地进程验收 |
| `npm test` | 上述四层的并集，不包含真实模型验收 |
| `npm run test:list` | 仅列出全部本地测试，并明确未运行真实验收 |

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

## 真实验收证据的只读审计器

`test/acceptance/` 提供一个只读审计器，用于复核真实模型／原生 CLI 轮次的证据：它读取父会话、扩展自身记录、原生日志与文件系统，**不启动模型、CLI 或 RPC，不执行 case 命令，也不改写任何记录**。它不属于任何 tier，也不被 `npm test` 选中。

```bash
node test/acceptance/audit.mjs .test-output/manual-acceptance/<case>/case.mjs
```

- `test/acceptance/evidence.mjs` 提供读取器与断言助手（不含顶层 await，case 可安全导入）；`test/acceptance/audit.mjs` 是入口；`test/acceptance/example.case.mjs` 是占位模板，不是真实证据。
- 每个 case 模块 default-export `{ name, session, check(ev) }`，只描述该轮必须证明的内容。case 模块属于**本地证据描述**，放在被忽略的 `.test-output/manual-acceptance/<case>/`，不提交、不随包分发；只有库与占位模板进入仓库。
- 证据分两类。不可变证据（父会话、扩展记录、原生日志、Claude/Codex 转录）直接断言；可变产物（效果文件、子 cwd、worktree、Git 状态）经 `ev.effects` 检查，产物已被清理时报告 `unavailable`，**既不判为通过也不判为失败**。PASS 输出同时给出 `effectsChecked` 与 `effectsUnavailable`，避免把"未检查"读成"通过"。
- 父会话是只追加的：轮次结束后的人工操作会追加自己的记录。不要断言"会话中不存在更晚的行"，而应按行号把该断言限定在本轮通知窗口内。
- 该审计器取代 2026-10-12 之前每轮手写的 `-audit.mjs`；旧脚本保留在各自 case 目录作为历史记录。首轮以 2026-10-11/10-12 的 8 个真实轮次回放验证，8/8 PASS，其中产物已清理的轮次逐项列出 `unavailable`。回放不构成新的真实模型验收。

## Tiers, gates and known flakes

Four local tiers, all selected from `scripts/test-tiers.json` (every `*.test.mjs` must be classified exactly once):

| Tier | What belongs here | Wall clock on 2026-10-18 |
| --- | --- | --- |
| `fast` | pure logic, record-level stubs, no child process | ~27s |
| `domain` | local git/persistence/adapters against fixtures | ~94s |
| `acceptance-local` | closed-loop manager/UI rounds with the local CLI fixture | ~125s |
| `acceptance-slow` | the three heavy real-process files (`manager`, `residency`, `workspace-manager`) | ~165s |

`npm run gates` builds once and runs check, fast, domain and acceptance-local in order, printing a
per-gate wall clock and a single exit code; `npm run gates -- --slow` adds acceptance-slow for a
close-out run. Without `--slow` the same four gates used to rebuild `dist` four times (~4s each).

`scripts/known-flakes.json` labels the failures already investigated (I-007 in `shutdown`, I-015 in
`residency`). The label is printed before and after a run, but a hit is still a failure and still
exits non-zero: it only saves a reader the diagnosis.

## Environment isolation

Each execution creates a temporary `PI_CODING_AGENT_DIR` and applies it before child-process module imports, preventing the user's worker-role configuration from redirecting a Pi fixture to real Codex/Claude. It also clears the inherited `PI_CLI_SUBAGENT` marker so extension registration does not return early. The real child-agent recursion guard remains intact; tests do not disable it.

The Node runner uses `--test-concurrency=1` and does not modify the parent process environment or the user's global configuration. The temporary home is cleaned up on normal completion and failure, preserving the test exit code. This entry point is not an OS sandbox and does not guarantee temporary-directory cleanup after a force kill or power loss.

Launcher tests use independent miniature repositories to verify real process boundaries. Before starting the inner runner, they remove `NODE_TEST_CONTEXT` only in the fixture environment so Node does not mistake it for recursive execution of the outer test and silently skip it.

## 开发 SDK 与安全依赖

开发用的 Pi AI、coding-agent、TUI 三个直接依赖统一固定为 `1.0.1`，运行时 peer 仍为 `*`，不打包宿主副本。它是 `0.87.1` 之后首个显式依赖 `brace-expansion 5.0.12` 的稳定 SDK；更早版本的 shrinkwrap 会把传递依赖恢复为有告警的 `5.0.9`。

仅对 SDK `1.0.1` 的 `pi-codemode` 使用同版本 override：其 `^1.0.1` 范围会解析到移除了 `MCP_TYPESCRIPT_PREAMBLE` 的新版，导致 SDK 导入失败。不能只因 audit 清零就删除这个兼容约束；变更后须验证真实导入和加载器。

升级后用干净的 `npm ci --ignore-scripts` 验证实际安装树与 `npm audit`，不要只检查锁文件字面值。就地升级可能残留旧嵌套依赖；按当前 manifest 重建干净锁后再验收。复用既有隔离解包加载器与本地 worker 夹具，分别检查开发 SDK 和实际宿主；这些 PASS 不代表真实模型验收。

## 转录读取兼容性变更

已删除 `TranscriptReader.readRecent()` 及其尾部预览、后台全量重放和交接状态。直接深度导入 `dist/transcript.js` 调用该方法的外部代码需要迁移；不保留兼容代理。顺序解析继续使用 `TranscriptReader.read()`，交互式历史查看继续使用现有 `TranscriptWindow` 的有界按需分页。相关旧 API 测试随行为退休；独立的 UI 暂停定位、合并绘制与通知保留测试迁入 `conversation.test.mjs`，分页、原生身份过滤及字节边界仍由现有 window/seek 测试覆盖。

## Claude 原会话恢复预检

版本预检保留 `2.1.x` 且补丁号至少为 `283` 的边界，并继续检查运行时协议能力。该条件不是“任意版本号大于等于 2.1.283”；`2.2.x`、`3.x`、预发行后缀等均不自动放行。此处是经验证的接入边界，扩展支持范围前需要重新验证原生协议。

恢复保留原 native home、sessionId 和唯一转录文件，不自动新建替代会话。只读预检以 65,536 字节分块读取文件头，直到首条主线身份记录完整可读，总量最多 4 MiB；另检查末尾最多 65,536 字节。文件头首条非 sidechain 的 user/assistant 记录必须含原 sessionId 和与 spec.cwd 一致的启动目录；后续工具执行可改变 cwd，不再将动态目录当作启动身份。采样中的外国 sessionId、非法 cwd 类型、错误启动目录仍拒绝。文件头缺少可验证起点时 fail-closed，不用后续匹配行或文件尾代替原始身份，也不改写原转录。Claude 的初始任务和忙碌输入在发送前限制为最多 1 MiB 的 JSON 编码字符串，为身份记录元数据保留预算；超限明确拒绝，不发送输入。本地夹具覆盖中文与 emoji 的长首条任务释放后原身份恢复，以及超限输入不污染健康轮次。

依据 [官方会话恢复文档](https://platform.claude.com/docs/en/agent-sdk/sessions) 和 [官方 SDK 的文件头 cwd 提取](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/sessions.py)，沿用现有 native-resume 接线，不引入 SDK 依赖。既有 adapter 域测试覆盖动态目录和拒绝边界；manager 本地替身覆盖自然完成及 stop 后同身份恢复、历史记忆和固定启动目录。真实 Claude 续聊仍须单独授权；cwd 预检与驻留生命周期分别验收，前者通过不代表真实驻留能力通过。

Claude 驻留验收复用原 adapter/manager/workspace 替身：同 worker/CLI 多轮、初始化只出现一次、队列多结果合成一轮结果、后台屏障、旧 UUID/旧问题隔离、显式中断与自然完成竞态、取消排队输入、回执缺失及超时后的新工作拒绝。运行中 steer/followUp 对应原生 priority next/later，不发送隐式 interrupt；忙碌消息要求 msg_lifecycle_v1，独立中断要求 interrupt_receipt_v1 和 interrupt_cancel_queued_v1。中断回执和原生终态都确认后才返回 settled；背景工作仍未收口时不能假装 idle。idle 保留工作区 writer，交接/集成前仍须 stop；stop 释放资源而不删历史。真实 Claude 驻留、多轮消息和中断、人工 TUI 均未运行。

## 角色默认值回显

角色面板只回显未覆盖字段，不加“原生默认”标注，不把回显值写入角色文件。保存其他字段、打开/关闭选择器不会冻结继承；用户明确选中一个值才创建该字段的覆盖。切换 CLI 仍清除旧后端字段，个人草稿即使被项目同名角色遮盖，也按个人草稿的 CLI 显示字段和选择器。

- Pi 回显父会话当前 provider/model/thinking；Codex 用原生 `config/read` 读取当前 cwd 的配置层，不创建 thread/turn。只有审批策略和 sandbox 都匹配时才显示我们的 mode 预设，否则显示原生组合，不静默改成近似权限。
- Claude Code 只读实际 `CLAUDE_CONFIG_DIR`、当前 cwd 的共享/本地 settings 和文件型 managed settings，白名单保留模型/effort 相关环境变量；不读取认证文件、不保留或输出凭证字段，不启动 Claude、不执行 hooks/helpers，不获取账户或服务器管理策略。这是本地配置快照，不是运行中实例的生效值证明。
- 未明确配置或动态模型/权限默认值无法离线确定时显示 `default`，不猜订阅默认模型或固定 effort；读取失败显示 `unavailable`。非 Windows 的 Git 子目录/linked worktree 等无法确定 local settings 路径时也不猜。重新打开面板刷新快照；已有 worker 不热更新。
- 回显中的 `bypassPermissions`、`full-access` 和原生 `never` 审批组合仍保留权限告警。本地 fixture 覆盖来源、父模型、CLI 切换、默认选择定位、同名模型 provider、保存不冻结、重开刷新、关闭/会话切换后的迟到结果；不替代人工 TUI 或真实模型验收。

## /agents 列表与释放

主界面不再安装下方实例快捷选择器，仅保留状态摘要与 `/agents`（Ctrl+Alt+A）。列表先为选中实例保留一行，再计入实际存在的滚动标记；窗口缩放和窄列不能让状态文字挤掉实例身份。

运行图标复用外部状态摘要的同一 80ms 动画帧，不新增计时器或读盘；waiting、idle 和终态保持静态图标。已打开面板接收既有 800ms 监控快照，状态、问题和释放候选随之更新，elapsed 在绘制时计算。更新按实例 ID 保留选中项与同轮详情滚动；新轮清除旧结果滚动，当前详情目标消失时退回列表而不切到另一实例。历史开关保持不变，关闭、执行动作或切换父会话后解除快照回调。用 mock timers 和真实扩展接线验证读取次数、共享帧、状态变化及无迟到重绘。

对于已知 v2 idle owner，面板及会话查看器的 `x` 要求没有待处理请求；`c` 仅批量释放同类目标。确认前复读状态，执行时传入捕获的 runId/runtimeId 并复用 onlyIdle 准入，拒绝变忙或换代的目标，不重试。执行中的 Pi/Codex 可用 `t` 中断当前轮，之后才可释放；不改变父代理工具的主动 stop 契约。

对于带有 v2 runtimeId 的 `unreachable` 实例，详情页与会话查看器另提供 `x release uncertain`：单独确认可能结束工作、丢弃未报告输出，且不能据此推断输入是否执行。确认前复读目标，调用现有绑定 runId/runtimeId 的受保护 stop；身份变化、已恢复为已知执行状态、所有权或控制能力不足时仍拒绝，不自动重试。该入口不加入 `c` 的 idle 批量目标，不显示在已回收配额或已确认关闭的实例上，也不为 v1 增加强制关闭能力。

默认隐藏 manager 查询已确认关闭所有权的 v2 实例（closed + runtimeClosed），不依赖仅存在于操作响应的 receipt。列表按 `h` 查看历史，结果、原生会话恢复和文件均保留；unreachable 或旧版未确认状态不会冒充已释放。

人工操作记录默认一行折叠，使用 Pi 当前展开键查看完整正文。批量成功只弹出释放数量，部分失败仍显示各目标诊断；原正文、outbox、去重及 `triggerTurn:false` 保持不变。覆盖列表边界、历史恢复、忙碌/换代拒绝、真实本地 fixture 释放和无模型消息组件；不替代人工 TUI 与真实模型验收。

## Tier selection rules

1. For everyday changes, run the fast tier and relevant domain files. Changes to shared entry points such as `src/index.ts` or notifications/receipts also need the corresponding local acceptance checks.
2. For native CLI adapter changes, run the relevant adapter domain tests and manager/workspace local acceptance checks. This does not automatically authorize real-model calls.
3. Close-out without CI requires at least the complete fast and domain tiers. Use `npm test` for full local regression after changes to shared schemas, cross-tier contracts or test entry points.
4. Update the manifest before adding tests. Classify by actual dependencies, not filenames. A few mixed-tier files remain, such as `core.test.mjs` and `tool-receipts.test.mjs`; do not refactor their contents just for tiering.
5. Treat 20 seconds of fast-tier wall time as a review threshold, not a failure gate. If exceeded, check machine load, dependencies and tier assignment first; do not remove safety coverage to meet a time or test-count target. Removing or merging tests requires separate counterexample/mutation evidence.

## Cost measurements

These measurements were collected in one run per entry point on 2026-10-08 at `685b6c3` (Windows / Node 22.21.0); each entry point includes one build. All passed with skipped=0; real CLI/model acceptance was NOT_RUN throughout. The counts are the current suite, which is larger than the historical `b45f3a6` baseline in the tables above.

| Entry point | Passed / total | Wall time including build | Node runner time |
|---|---:|---:|---:|
| `npm run test:fast` | 262 / 262 | 20.17 s | 16.09 s |
| `npm run test:domain` | 65 / 65 | 70.72 s | 66.55 s |
| `npm run test:acceptance:local` | 90 / 90 | 179.71 s | 175.25 s |
| `npm test` | 417 / 417 | 248.29 s | 243.99 s |

Tiering reduces the cost of selecting tests for everyday changes; it does not claim to accelerate the full suite. The full-suite 248.29 seconds came from an independent run, not the sum of the three tier times. The fast tier now carries 29 files and 262 tests (the baseline above had 26 and 239), which is why its 20.17 seconds including build sits at the review threshold in rule 5. Local logs are in the ignored `.test-output/tiers-*.log` and `tiers-timings.json`. Remeasure after environment or test changes; this table is not a continuing performance guarantee.
