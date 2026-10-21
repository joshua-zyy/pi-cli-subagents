# 本地测试分层与验证成本

问题、尝试过的方法、对应分支、失败证据和当前结论统一维护在插件迭代记录（本地保留，不进仓库、不随包发布）；本页保留测试入口、分层与验证边界。

## 测试入口与边界

复用现有 Node 测试入口；`scripts/test.mjs` 在导入前隔离环境并按文件串行执行。当前有四层，精确文件集合以 manifest 为准，测试数量与耗时以当次输出为准。

| 入口 | 范围 |
|---|---|
| `npm run test:fast` | 纯逻辑、UI 与转录投影，允许临时文件 I/O，不启动 CLI/Git |
| `npm run test:domain` | 协议、adapter 和存储，使用本地替身 |
| `npm run test:acceptance:local` | manager、扩展入口、UI、审批和恢复的本地闭环 |
| `npm run test:acceptance:slow` | manager 和驻留的重型本地进程验收 |
| `npm test` | 上述四层的并集，不包含真实模型验收 |
| `npm run test:list` | 仅列出全部本地测试，并明确未运行真实验收 |

执行入口会先构建 `dist/`，`test:list` 除外。已有最新构建时，可直接运行 `node scripts/test.mjs fast`。

文件分类定义在 [`scripts/test-tiers.json`](../scripts/test-tiers.json)。每个正式的 `.test.mjs` 文件必须且只能属于一层；重复、遗漏、缺失文件或非测试条目都会在导入测试前失败，不会静默跳过。

```bash
# 仅列出某一层，不执行
node scripts/test.mjs domain --list

# 仅运行该层的指定文件，不隐式运行 fast 层
npm run test:domain -- storage-race.test.mjs
npm run test:acceptance:local -- extension.test.mjs tool-receipts.test.mjs
```

入口拒绝其他层的文件、未知层、任意路径和 `real-smoke.mjs`。`test/real-smoke.mjs` 等真实模型脚本不在这些入口内，输出明确标为 **NOT_RUN**；原有独立调用方式不变，仍须用户明确授权。本地 PASS 不代表真实 CLI、模型、系统崩溃场景或人工 TUI 体验已验收。

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

## 分层、门禁与已知偶发失败

四个本地层均从 `scripts/test-tiers.json` 选取，每个 `*.test.mjs` 必须且只能归入一层：

| 分层 | 范围 | 2026-10-18 的一次实测耗时 |
| --- | --- | --- |
| `fast` | 纯逻辑与记录替身，不启动子进程 | ~27s |
| `domain` | 本地 Git、持久化和 adapter 的夹具验证 | ~94s |
| `acceptance-local` | 使用本地 CLI 夹具的 manager/UI 闭环 | ~125s |
| `acceptance-slow` | 重型进程验收文件：`manager`、`residency`（历史耗时包含现已退役的 `workspace-manager`） | ~165s |

`npm run build` 与门禁复用 `scripts/build.mjs`：先清理 `dist/`，再使用当前 Node 的 `process.execPath` 执行本地 TypeScript 入口，不通过 shell、`npm.cmd` 或 PATH 中的编译器包装脚本。构建与门禁从脚本所在仓库定位工作目录。

`npm run gates` 只构建一次，依次运行 check、fast、domain、acceptance-local，并输出各门禁耗时和统一退出码。`npm run gates -- --slow` 增加 acceptance-slow，用于收尾验收。此前分开执行这些入口会重复构建四次，每次约 4 秒。

`scripts/known-flakes.json` 标注已调查的偶发失败：`shutdown` 的 I-007 和 `residency` 的 I-015。运行前后都会输出标注，但命中仍算失败，退出码仍非零；标注只提供诊断线索。

## 跨平台 CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) 配置 Windows、Ubuntu、macOS 三个平台，在 push、pull request 或手动触发时使用项目最低 Node.js 版本 `22.19.0`。通过 `npm ci --ignore-scripts --no-audit --no-fund` 安装锁定的开发依赖，然后执行 `node scripts/gates.mjs --slow`：类型检查、一次构建和现有四层本地测试。无需模型凭据，不安装或登录真实 Codex／Claude CLI。

每个平台独立报告失败；一个平台失败不取消另外两个，不自动重试，也不以 `continue-on-error` 忽略失败。工作流仅授予 `contents: read`，checkout 不保留 Git 凭据；不缓存依赖。30 分钟是整个 CI job 的截止时间，不修改用例或产品的超时。

配置文件存在不代表三平台已经通过。运行结果以对应提交的 GitHub Actions 记录为准；通过后证明的是该 runner／Node 组合下的本地逻辑和真实 OS 子进程夹具，包括已有父退出、重连和释放路径，不替代真实原生 CLI／模型、人工 TUI 或所有 CPU／文件系统的验收。Windows 专用用例在其他平台的显式 skip 仍需如实报告；未运行的平台仍为未验证。

## 环境隔离

每次执行都会创建临时 `PI_CODING_AGENT_DIR`，在导入子进程模块前应用，避免用户的 worker 角色配置把 Pi 夹具重定向到真实 Codex/Claude。入口还会清除继承的 `PI_CLI_SUBAGENT`，避免测试宿主的扩展注册提前返回；真实子代理的递归保护仍保留，测试不关闭该保护。

Node 测试运行器使用 `--test-concurrency=1`，不修改父进程环境或用户全局配置。正常完成或失败后都会清理临时目录并保留测试退出码。该入口不提供操作系统沙箱，也不保证强制结束或断电后仍能清理目录。

运行器测试使用独立的小型仓库验证真实进程边界。启动内部运行器前，仅在夹具环境中移除 `NODE_TEST_CONTEXT`，避免 Node 将其误认为外层测试的递归执行而静默跳过。

## 开发 SDK 与安全依赖

开发用的 Pi AI、coding-agent、TUI 三个直接依赖统一固定为 `1.0.1`，运行时 peer 仍为 `*`，不打包宿主副本。它是 `0.87.1` 之后首个显式依赖 `brace-expansion 5.0.12` 的稳定 SDK；更早版本的 shrinkwrap 会把传递依赖恢复为有告警的 `5.0.9`。

仅对 SDK `1.0.1` 的 `pi-codemode` 使用同版本 override：其 `^1.0.1` 范围会解析到移除了 `MCP_TYPESCRIPT_PREAMBLE` 的新版，导致 SDK 导入失败。不能只因 audit 清零就删除这个兼容约束；变更后须验证真实导入和加载器。

升级后用干净的 `npm ci --ignore-scripts` 验证实际安装树与 `npm audit`，不要只检查锁文件字面值。就地升级可能残留旧嵌套依赖；按当前 manifest 重建干净锁后再验收。复用既有隔离解包加载器与本地 worker 夹具，分别检查开发 SDK 和实际宿主；这些 PASS 不代表真实模型验收。

## 托管工作区退役覆盖

已退休 `workspace.test.mjs` 的 Git 管理合同及专属租约、快照、keep/sync、checkpoint 与确认 UI 测试，
不以删测掩盖仍需保留的会话行为。`cwd.test.mjs` 复用三后端本地 CLI 夹具，覆盖普通子目录、驻留续轮、
释放后原会话与记忆恢复、用户自行创建/提交的分支式 worktree、失败恢复的原生身份和文件保留。
原控制器退出、原生元数据拒绝等通用行为仍由 manager/adapter 测试覆盖。

`tool-contract` 验证 schema 与直接执行均拒绝旧动作/字段；`manager-recovery` 验证三后端旧托管记录
在所有状态下先于派发与改写拒绝 send，且实际 pending reply、interrupt、stop 与结果读取保留。
`residency` 保留 closing 响应规范化、身份拒绝和不重发；query/UI/usage/角色的通用断言保留。
查询闭环在不可读旧工作区清单存在时仍成功，不启动 Git 扫描。以上均为离线本地证据，不证明模型会
自行组织 Git 协作，后者须单独进行有证据的真实任务验收。

### cwd-only 真实行为见证（2026-10-20）

实现提交 `6749d2a` 在 Windows / Pi 1.3.0 的原测试目录与原包路径上完成一次真实父 Pi → 子 Pi 任务。
原测试配置未改；使用临时 agent home 和一次性 Git 仓库，不加载 skill。父模型自己创建分支式 worktree、
通过 `cwd` 派发，同一实例/原生会话完成单单位时长解析和复合表达式两轮真实代码/测试修改。收到两次结果
后确认 `released`，父级检查 diff、运行测试、提交、合并、在集成目录重跑测试并正常清理 worktree/分支。
两个哨兵及原配置哈希未变，worker/CLI 均已退出，未使用监督器补做任务或清理。

只读审计器返回 PASS，4 项可变效果检查已执行、0 项不可用；清理后的子目录只断言预期不存在，未声称
继续检查其已删除文件。第一轮父测 57/57，第二轮及集成后均 95/95；插件自身另经 check/build 和四层
456/152/88/78（共 774）项本地测试。独立评审复核代码及增量用例，不能混称其独立重跑了全部四层。

原始父会话、两轮 request/result/native 日志、Git 命令与只读 case 保留为本地证据，不随包发布。
本次仅证明一条真实 Git/cwd 协作路径可完成，不推导节省 token/费用、普遍发现率或目录并发安全；不构成
Codex/Claude 真实模型、释放后恢复、审批、人工 TUI 或其它操作系统的重新验收。

### 按后端加载与双 CLI 问答真实见证（2026-10-21）

实现 `c3c01a7` 在 Windows / Pi 1.3.0 测试宿主完成一次真实父任务：Pi 与 Codex CLI 0.162.1 各一个实例、各两轮，模型为 gpt-6.1-sol、medium。临时角色目录只涉及这两个后端；父任务不包含技能文件路径或协议答案，不由监督器追加补读提示。

原始父会话显示：主 SKILL 在第9行读取，pi.md 在第13行、codex.md 在第28行读取，均早于对应首次控制；未读取 claude.md。真实任务问题分别通过 value 和 answers 回写，四个完成结果送达原父会话，续轮保持各自 native session/runtime。原生 Codex turn_context 也记录了同一模型、medium 和只读模式。两实例均由父代理取得 released 回执，记录中的 worker/CLI 已退出，owner.lock 缺失，无监督器补救。

只读审计器 PASS，3项可变效果全部可核查、0项不可用；五个业务边界样例正确。运行约119秒，只是本轮耗时，不作为性能或费用基准。角色文件恢复原始字节，6个受保护配置哈希一致，隔离凭据副本已删除，114个 dist 文件及预注册输入未改变。

原始 session/events/native、预注册、只读 case 和恢复证明保存在本地忽略目录 `.test-output/backend-guidance/real-01/`，不随包发布。复核：`node test/acceptance/audit.mjs .test-output/backend-guidance/real-01/case.mjs`；不启动模型或执行原任务。另有只读 postcheck 复用现有 evidence 读取器，复核实际工具声明及原生模型上下文。

本轮是业务分析问答，不是 Codex 代码实现验收；它不覆盖 Claude、运行中发送/中断时序、释放后恢复、权限审批、原生孙代理工具清单、人工 TUI 或其他操作系统，也不推导模型普遍遵从或 token/订阅费用改善。此前完整四层本地门禁仍是独立证据，不以本轮替代。

### 英文技能与 Claude Code 问答／续聊见证（2026-10-21）

基线 `c239c73`，Windows / Pi 1.3.0，父 `agentrouter2/deepseek-v4-flash`（medium），
子 Claude Code 2.1.296 / `sonnet`（high、manual），原生实际模型 `deepseek-v4-flash[1M]`。
这是 Claude Code 通道验收，不是 Anthropic 模型验收。

第六轮冻结审计 PASS（effects 3、unavailable 0），自然完成约45秒。父在第7行读完整英文 SKILL、
第12行读 claude.md、第20行首答复；未读未使用的后端说明。完整草案交接后，一次真实题卡包含
单选与多选，公开 answers 用完整 question 文本作键，并真正选择 Summary 与 Risks 两个现成项；
原生请求、control_response、成功 tool_result 与一次审计证明回写，不凭 attempted 收据推断成功。
两个 run 共用 native session/runtime/worker/CLI，两份完成报告自动送达，父自行 stop/released 并
写出最终文件，无监督器补救。两个逐轮 system/init 通知不表示进程重建；startup initialize 只有一次。

**语义限制**：子把拒绝记录不产出报告解释为 `sections: []`；父最终文件按验收要求存配置段
`["Summary","Risks"]`，并在回复中披露差异。冻结 gate 检查最终文件而非原报告的段落语义，
因此 PASS 只认证问答、记忆继承、报告与生命周期，不认证所有业务结论或父语义转换正确。

相关本地 fast44/domain27/local10 共81项及 check/build 通过。15个冻结输入、114个 dist 文件未变；
9个保护配置哈希一致，原角色字节恢复，临时凭据副本删除、实际秘密字节扫描0残留。
显式 session_start 诊断在实际 bundle 路径捕获14个父请求，全部 HTTP200，无 fetch/body 错误。
之前的路由、额度、连接、控制器失败均保留原始结论，本轮通过不倒推旧错误已修复。

原始证据只在本地忽略目录 `.test-output/backend-guidance/real-claude-06/`，不随包发布。
复核：`node test/acceptance/audit.mjs .test-output/backend-guidance/real-claude-06/case.mjs`；
另有同目录 closeout、diagnostic-check 和 monitor 的只读核查。未覆盖运行中发送/中断、
释放后恢复、权限审批、扩展 text/number 题卡、人工 TUI 或 Linux/macOS，也不证明可靠性/成本收益。

## 转录读取兼容性变更

已删除 `TranscriptReader.readRecent()` 及其尾部预览、后台全量重放和交接状态。直接深度导入 `dist/transcript.js` 调用该方法的外部代码需要迁移；不保留兼容代理。顺序解析继续使用 `TranscriptReader.read()`，交互式历史查看继续使用现有 `TranscriptWindow` 的有界按需分页。相关旧 API 测试随行为退休；独立的 UI 暂停定位、合并绘制与通知保留测试迁入 `conversation.test.mjs`，分页、原生身份过滤及字节边界仍由现有 window/seek 测试覆盖。

未使用的导出常量 `TEXT_FIELDS` 也已删除。深度导入 `dist/role-settings.js` 并依赖该常量的外部代码需要移除该依赖；不提供兼容导出。

## 运行时协议升级边界

当前只接受协议 v3，不保留旧 worker 的控制或恢复兼容。无协议标记的 v1、所有 v2 及其他版本均不会收到 status、start、send、reply、interrupt、stop 请求，也不能续跑或 reclaim；UI 隐藏旧实例的控制入口。旧记录的结果、活动和任务历史仍可只读查询，状态明确标为不支持，不把旧历史宣告为新的运行失败，也不自动迁移、重建运行或强制接管。

v3 把身份校验、受保护 stop 和操作回执作为统一契约，不再通过 endpoint 的 `preserveAccepted` 能力字段兼容旧 worker，也不从旧 accepted 标记补造回执。启动记录必须带 `protocolVersion: 3`；旧父进程生成的启动请求会在取得锁、启动 CLI 前拒绝。确认原生释放后直接将 phase: closed 写入磁盘，不再为降级读取保留旧终态枚举。`spec.version` 的 1/2/3 区分 Pi、Codex、Claude 后端，并非旧控制协议，仍保留。

升级前须先用旧扩展正常释放所有实例，再更新并重新加载父扩展；更新后不再从本版中断或释放旧 v2 worker。若仍有 v1/v2 进程，需要人工清理：

1. 从 `subagent_query get` 及实例目录的 `state.json`、`owner.lock`、日志中记录原 `workerPid`、`cliPid`、运行目录与实例身份。
2. 在操作系统进程详情中核对启动时间、命令行和父子关系，确认 PID 仍属于该实例。PID 可能复用；无法确认时不要按旧 PID 结束进程。
3. 仅人工结束确认属于该实例的 worker 与 CLI 子进程树。这会中断工作，可能丢失尚未报告的输出，不会撤销文件修改；保留会话与诊断记录。
4. 复查进程是否确实消失，不手工改写状态为 closed、不删除锁来伪造释放。旧记录不支持本版的 reclaim；人工结束后仍可能显示 unreachable 并占用**原父会话**的活动或驻留配额，本版本不提供旧记录自动迁移或配额回收。

只读历史中已有 `runtimeClosed: true` 且原 owner.lock 已缺失的记录仍作为释放证据，不重新占用活动或驻留配额；这不开放任何旧协议控制或恢复入口。

旧记录的活动或驻留占用只在其原父会话内生效；新建父会话使用独立的实例根目录与配额，因此不受旧记录影响。重启或人工结束旧进程只清理进程，不会改写旧 `state.json`；不再需要原父会话时，直接新建父会话即可，旧历史仍留在原父会话的只读记录中。

当前 v3 worker 已死亡时，stop 也不会伪造释放；只有在可靠确认原 worker 与 CLI 都已消失、且所有权身份符合条件时，才可通过显式 reclaim 回收配额。UI 不自动把释放失败改成 reclaim。

Pi 的 `handled` 失败释放说明只指初始输入，以及 idle/原会话恢复后启动新轮的输入；运行中 steer 被扩展处理时，不会把既有轮次改成失败或伪造终态，其 accepted 回执也不代表模型执行。

## Claude 原会话恢复预检

版本预检保留 `2.1.x` 且补丁号至少为 `283` 的边界，并继续检查运行时协议能力。该条件不是“任意版本号大于等于 2.1.283”；`2.2.x`、`3.x`、预发行后缀等均不自动放行。此处是经验证的接入边界，扩展支持范围前需要重新验证原生协议。

恢复保留原 native home、sessionId 和唯一转录文件，不自动新建替代会话。只读预检以 65,536 字节分块读取文件头，直到首条主线身份记录完整可读，总量最多 4 MiB；另检查末尾最多 65,536 字节。文件头首条非 sidechain 的 user/assistant 记录必须含原 sessionId 和与 spec.cwd 一致的启动目录；后续工具执行可改变 cwd，不再将动态目录当作启动身份。采样中的外国 sessionId、非法 cwd 类型、错误启动目录仍拒绝。文件头缺少可验证起点时 fail-closed，不用后续匹配行或文件尾代替原始身份，也不改写原转录。Claude 的初始任务和忙碌输入在发送前限制为最多 1 MiB 的 JSON 编码字符串，为身份记录元数据保留预算；超限明确拒绝，不发送输入。本地夹具覆盖中文与 emoji 的长首条任务释放后原身份恢复，以及超限输入不污染健康轮次。

依据 [官方会话恢复文档](https://platform.claude.com/docs/en/agent-sdk/sessions) 和 [官方 SDK 的文件头 cwd 提取](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/sessions.py)，沿用现有 native-resume 接线，不引入 SDK 依赖。既有 adapter 域测试覆盖动态目录和拒绝边界；manager 本地替身覆盖自然完成及 stop 后同身份恢复、历史记忆和固定启动目录。释放后恢复未在上述真实问答轮次覆盖，仍须单独授权；cwd 预检与驻留生命周期分别验收，前者通过不代表后者通过。

Claude 驻留验收复用原 adapter/manager 与 cwd 替身：同 worker/CLI 多轮、启动 initialize 握手只发生一次（逐轮 system/init 通知可重复）、队列多结果合成一轮结果、后台屏障、旧 UUID/旧问题隔离、显式中断与自然完成竞态、取消排队输入、回执缺失及超时后的新工作拒绝。运行中 steer/followUp 对应原生 priority next/later，不发送隐式 interrupt；忙碌消息要求 msg_lifecycle_v1，独立中断要求 interrupt_receipt_v1 和 interrupt_cancel_queued_v1。中断回执和原生终态都确认后才返回 settled；背景工作仍未收口时不能假装 idle。idle 仍拥有运行时，目录交接/清理前须确认释放；stop 释放资源而不删历史。真实 Claude Code 两轮 idle 续聊已由上述问答见证覆盖；运行中多轮消息和中断、人工 TUI 仍未运行。

## 角色默认值回显

角色面板只回显未覆盖字段，不加“原生默认”标注，不把回显值写入角色文件。保存其他字段、打开/关闭选择器不会冻结继承；用户明确选中一个值才创建该字段的覆盖。切换 CLI 仍清除旧后端字段，个人草稿即使被项目同名角色遮盖，也按个人草稿的 CLI 显示字段和选择器。

- Pi 回显父会话当前 provider/model/thinking；Codex 用原生 `config/read` 读取当前 cwd 的配置层，不创建 thread/turn。只有审批策略和 sandbox 都匹配时才显示我们的 mode 预设，否则显示原生组合，不静默改成近似权限。
- Claude Code 只读实际 `CLAUDE_CONFIG_DIR`、当前 cwd 的共享/本地 settings 和文件型 managed settings，白名单保留模型/effort 相关环境变量；不读取认证文件、不保留或输出凭证字段，不启动 Claude、不执行 hooks/helpers，不获取账户或服务器管理策略。这是本地配置快照，不是运行中实例的生效值证明。
- 未明确配置或动态模型/权限默认值无法离线确定时显示 `default`，不猜订阅默认模型或固定 effort；读取失败显示 `unavailable`。非 Windows 的 Git 子目录/linked worktree 等无法确定 local settings 路径时也不猜。重新打开面板刷新快照；已有 worker 不热更新。
- 回显中的 `bypassPermissions`、`full-access` 和原生 `never` 审批组合仍保留权限告警。本地 fixture 覆盖来源、父模型、CLI 切换、默认选择定位、同名模型 provider、保存不冻结、重开刷新、关闭/会话切换后的迟到结果；不替代人工 TUI 或真实模型验收。

## /agents 列表与释放

主界面不再安装下方实例快捷选择器，仅保留状态摘要与 `/agents`（Ctrl+Alt+A）。常驻摘要只展示 starting/running/waiting/stopping：idle 与所有终态立即不占行，不再保留 30 秒结束记录；没有进行中或待回复工作时注销整个 widget 并停止动画，新任务恢复时重新注册。这仅改变展示，不释放进程、不删除失败诊断或历史；空闲实例仍可在 `/agents` 管理，既有结果/错误报告照常投递。交互列表恢复公开 `setWidget(..., { placement: "aboveEditor" })` 与 `onTerminalInput`，参与输入框上方的正常布局，不修改 Pi、不覆盖聊天或替换编辑器焦点。打开时仅隐藏自身重复摘要，保留同一动画与快照时钟。自然高度先扣除聊天、间隔、编辑器、页脚及已知额外行；可用时通过 TuiBase 的公开焦点 getter 测量多行编辑器（通用 TUI 类型未声明此方法，故运行期检测，不读私有字段）。宽窗扩大、窄窗收缩，放不下的实例内部滚动，不恢复固定八项上限；先保留选中身份，再放标题、提示和实际存在的滚动标记。Ctrl+C 只中断忙碌父会话；父会话空闲时关闭面板，不操作子代理。

除独立组件测试外，`ui-loop` 将真实扩展接线放入 Pi 的 `createChatViewport` 与 `TuiAltScreen`，在空间足够时叠加 Todo widget，在同一面板上连续缩放、通过宿主输入路径双向遍历，检查最终屏幕的选中身份、完整边框、聊天和输入框及宽度边界，并验证高窗九实例同屏、16 行窗口内的七行草稿、Esc 后输入归还原编辑器。此项不等同于人工终端观感验收。

原版宿主仍会压缩整个 widget 区域，插件拿不到最终分配高度，故自然高度预算不是任意宿主组合的布局保证。普通三行编辑器/两行页脚的最小完整面板为 10 行终端；审批状态多占一行时至少 11 行，父工作指示、多行草稿也消耗同一预算。更矮时降级为无边框紧凑内容。第三方 widget、额外 footer/status 或排队消息占满空间时仍可能被宿主裁切；不接管其他插件区域，不以浮层或宿主补丁绕过。

运行图标复用外部状态摘要的同一 80ms 动画帧，不新增计时器或读盘；waiting、idle 和终态保持静态图标。已打开面板接收既有 800ms 监控快照，状态、问题和释放候选随之更新，elapsed 在绘制时计算。更新按实例 ID 保留选中项与同轮详情滚动；新轮清除旧结果滚动，当前详情目标消失时退回列表而不切到另一实例。历史开关保持不变，关闭、执行动作或切换父会话后解除快照回调。用 mock timers 和真实扩展接线验证读取次数、共享帧、状态变化及无迟到重绘。

对于已知 v3 idle owner，面板及会话查看器的 `x` 要求没有待处理请求；`c` 仅批量释放同类目标。确认前复读状态，执行时传入捕获的 runId/runtimeId 并复用 onlyIdle 准入，拒绝变忙或换代的目标，不重试。执行中的 Pi/Codex 可用 `t` 中断当前轮，之后才可释放；不改变父代理工具的主动 stop 契约。

对于带有 v3 runtimeId 的 `unreachable` 实例，详情页与会话查看器另提供 `x release uncertain`：单独确认可能结束工作、丢弃未报告输出，且不能据此推断输入是否执行。确认前复读目标，调用现有绑定 runId/runtimeId 的受保护 stop；身份变化、已恢复为已知执行状态、所有权冲突或进程死亡时仍拒绝，不自动重试。该入口不加入 `c` 的 idle 批量目标，不显示在旧协议、已回收配额或已确认关闭的实例上。

默认隐藏 manager 查询已确认关闭所有权的 v3 实例（closed + runtimeClosed），不依赖仅存在于操作响应的 receipt。列表按 `h` 查看历史，结果和文件保留；只有当前协议实例可恢复，unreachable 或旧版未确认状态不会冒充已释放。

人工操作记录默认一行折叠，使用 Pi 当前展开键查看完整正文。一次 `c` 批量确认只生成一个 actionId 和一张 Human action 卡片；标题按结构化回执显示已释放、未确认、未尝试或结果未记录的数量，正文保留每项捕获的 agent/run/runtime 身份、回执及诊断。单项动作和旧历史记录不改写，不按时间合并不同批次。

批量记录复用首个捕获实例的 outbox 目录，确认后先保存目标集，每项返回后原子更新，结束或父会话切换时在 finally 封口；执行中不提前投递半张卡片。原控制进程已不存在时，未封口批次可作为中断记录补投，未记录结果不能冒充“未执行”或“已释放”；进程仍存活或存活性未知时不提前投递（PID 被复用也可能延迟此类补投）。原父会话归属、custom_message 收据与 pending 去重、`triggerTurn:false` 保持，补投绝不重放释放操作。批量成功 toast 仍只显示数量，部分失败保留各目标诊断。

覆盖列表边界、历史恢复、忙碌/换代拒绝、真实本地 fixture 释放、逐项原子保存、跨父快速返回、进程退出恢复和无模型 SDK/消息组件；不替代人工 TUI 与真实模型验收。

## 测试分层选择规则

1. 日常修改运行 fast 层和相关 domain 文件；修改 `src/index.ts` 等共享入口或通知、回执时，还须运行对应本地验收。
2. 修改原生 CLI adapter 时，运行相关 adapter 域测试及 manager/cwd 本地验收；这不自动授权真实模型调用。
3. 无 CI 时，收尾至少运行完整 fast 和 domain 层。修改共享结构、跨层契约或测试入口后，用 `npm test` 执行全量本地回归。
4. 新增测试前更新 manifest，按真实依赖分类，不按文件名分类。`core.test.mjs`、`tool-receipts.test.mjs` 等少数文件混合了多个层次，不应只为分类而重构内容。
5. fast 层总耗时 20 秒是复核阈值，不是失败门禁。超出时先检查机器负载、依赖和分类；不为时间或数量目标删除保护性覆盖。删除或合并测试须有独立反例或变异验证证据。

## 历史成本测量

以下是 2026-10-08 在 `685b6c3`（Windows / Node 22.21.0）上的历史测量，每个入口各运行一次，含一次构建。全部通过且 skipped=0，真实 CLI/模型始终为 NOT_RUN。当时测试数量高于更早的 `b45f3a6` 基线，不代表当前数量。

| 入口 | 通过 / 总数 | 含构建总耗时 | Node 测试耗时 |
|---|---:|---:|---:|
| `npm run test:fast` | 262 / 262 | 20.17 s | 16.09 s |
| `npm run test:domain` | 65 / 65 | 70.72 s | 66.55 s |
| `npm run test:acceptance:local` | 90 / 90 | 179.71 s | 175.25 s |
| `npm test` | 417 / 417 | 248.29 s | 243.99 s |

分层降低日常选择测试的成本，不保证加速全量执行。表中的全量 248.29 秒来自独立运行，不是三层耗时相加。当时 fast 层有 29 个文件、262 项测试，更早基线为 26 个文件、239 项测试；含构建 20.17 秒达到规则 5 的复核阈值。本地历史日志位于忽略的 `.test-output/tiers-*.log` 和 `tiers-timings.json`。环境或测试变化后应重新测量，本表不提供持续性能保证。
