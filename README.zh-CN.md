# pi-cli-subagents

[English](README.md)

让 Pi 把任务交给**可复用的 Pi、Codex 和 Claude Code 会话**：独立任务并行执行，完成后自动回报，后续修改继续找原来的代理。需要隔离并行改动时，可使用托管 Git 工作树。

## 快速开始

需要 Node.js **>=22.19** 和已配置好的 Pi CLI。使用 Codex 或 Claude Code 时，需另外安装并完成认证。

```bash
# 在本扩展目录中
npm ci
npm run build

# 在需要使用扩展的项目目录中
pi install --local /absolute/path/to/pi-cli-subagents
pi
```

将路径替换为本扩展的绝对路径。本地安装会把扩展及配套技能加入 `.pi/settings.json`，项目信任提示请自行确认。不想修改设置，可临时加载：

```bash
pi --extension /absolute/path/to/pi-cli-subagents/dist/index.js \
   --skill /absolute/path/to/pi-cli-subagents/skills/delegate-cli-agents
```

然后直接对 Pi 说，例如：

> 让已配置的 worker 在独立 worktree 中调查并修复这个测试，完成后报告结果。

角色、任务拆分及审查策略由用户决定，插件不预设代理工作流。

父会话必须持久化，**不要使用 `--no-session`**。完成报告自动送达，无需轮询。父进程退出后，运行中的子代理可以继续工作；回到**原来的父会话**即可接收待投递报告。

## 角色与模型

四个内置角色默认都使用 Pi：`explore` 调查、`worker` 实现并验证、`reviewer` 独立审查、`oracle` 提供第二意见。角色的只读指令**不等于权限沙箱**。

用 **`/cli-agents-setting`** 为角色选择 CLI 和模型：**Tab** 切换用户/项目配置，**Enter** 编辑，**s** 保存，**Esc** 返回上一层；在角色列表中关闭，有未保存更改时先确认。小面板也会保留当前选中的角色、字段或选项。保存后对下一次派发生效。

也可以直接编辑角色文件：

- 用户级：`~/.pi/agent/cli-subagents.roles.json`
- 受信项目：`.pi/cli-subagents.roles.json`

优先级为**项目 > 用户 > 内置**。同名配置会替换整个角色，`description` 和 `instructions` 必填。例如只把 reviewer 改为 Codex（请替换模型占位符）：

```json
{
  "reviewer": {
    "cli": "codex",
    "description": "独立审查改动",
    "instructions": "检查指定改动，不修改文件。报告有证据支持的问题，并说明实际验证了什么。",
    "model": "YOUR_AVAILABLE_CODEX_MODEL",
    "effort": "high",
    "mode": "read-only"
  }
}
```

| CLI | 模型设置 | 权限设置（`mode`） |
| --- | --- | --- |
| Pi | `provider`、`model`、`thinking`；未设置项在启动时跟随父会话 | 不支持 |
| Codex | 必填 `model`；可选该模型支持的 `effort` | `read-only`、`workspace-write`、`full-access` |
| Claude Code | 可选 `model`、`thinking`（转为 `--effort`） | `manual`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions` |

这些设置只用于实例启动，不改写各 CLI 的全局配置。Codex/Claude 未设置的可选项使用原生默认值。**不要假定一定会出现审批提示**：`dontAsk`、`bypassPermissions` 和 `full-access` 都会抑制提示，但拒绝/放行行为不同。除非明确要覆盖原生权限策略，否则不要设置 `mode`。

**Codex Default 模式提问（实验特性）：** 仅 Codex 角色支持 `defaultModeQuestions`，也可通过 `/cli-agents-setting` 选择三种状态：

- `true`：通过进程参数 `-c features.default_mode_request_user_input=true` 开启。
- `false`：用同一参数显式关闭 Default 模式提问，不影响 Plan 模式提问。
- 未设置（面板选 `inherit`）：不传覆盖参数，继承原生 Codex 配置；CLI 0.159.2 将该特性标为开发中，原生默认关闭。

例如，在现有 Codex 角色中加入 `"defaultModeQuestions": true` 即可选择开启。它不切换协作模式，不改变 `model`／`effort`／审批／沙箱，也不写全局配置；不会覆盖独立的工具注册设置 `tools.experimental_request_user_input.enabled`（0.159.2 未配置时默认开启）。角色更改只对**新实例**生效，已有实例恢复时沿用保存的角色，不能通过事后修改角色获得此覆盖。若原生工具仍不可用，应检查实际 CLI 版本与配置，不能靠提升权限或静默重试解决。降级或与旧版扩展共用角色文件前须移除此字段：旧版会因未知字段拒绝整份角色文件。

## 查看与续聊

输入 **`/agents`** 或按 **Ctrl+Alt+A** 打开面板。用 **↑/↓** 选择实例，**Enter/v** 查看实时对话，**s** 发消息或恢复，**r** 回答请求，**x** 停止。关闭查看器不会停止子代理。首次打开只读取一段有界的尾部窗口，之后只跟随新追加的字节；向上翻阅（**PgUp**、**↑**）接近已加载内容顶部约两屏时，按方向提前加载更早的一页，并保持当前阅读位置；**Home** 可直接触发。加载期间继续向上翻阅的距离会在数据到达后执行，同方向请求合并，不会因为靠近另一端而反向加载；**End** 会取消此前的向上翻阅意图。磁盘读取页最多保留 300 条；页面另有独立的内容列表（最多 1200 条、8 MiB 文本与标识预算），不会随着读取窗口换页而整段替换。超限时优先淘汰翻阅方向另一端的非可见内容，不移除正在阅读的条目；暂停时屏内内容固定，回到末尾后同步已读取的最新内容。仍能逐页翻到最早的记录，也能向后逐页翻回；**End** 重新锚定到最新输出。在同一进程内再次打开同一实例会复用已分页的窗口，因此停在旧页的窗口不会自动跳回最新，需按 **End** 明确回尾；日志被替换或截断时该窗口作废。只有在已加载窗口确实覆盖了全部 run 时才显示整段 token 统计，否则头部显示 **Stats incomplete**，不会显示不完整的数字冒充总量。期间仍可翻阅、查看状态、发消息或停止，且从不改写事件日志。

查看器借鉴 [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) 的“会话内容列表 + 显示偏移 + 自动跟随”模型，每次按键按当前内容计算滚动边界；本项目额外适配独立 CLI 的按需日志读取，而非直接持有 SDK 的 `session.messages`。

实时查看器中的工具默认只显示一行摘要，失败也不例外（用 `✗` 标识）。**Ctrl+O** 统一展开／收起当前查看器已加载的工具参数和输出，遵循宿主 `app.tools.expand` 的改键或解绑设置，不改变主会话的折叠状态。新输出到达后保持当前展开状态；**Enter** 仍用于打开消息输入框。长内容仍受既有读取上限约束并保留截断提示，原始日志不变。

| 父代理可用工具 | 用途 |
| --- | --- |
| `subagent` | `start` 启动角色、`send` 向原实例发消息、`stop` 停止当前工作 |
| `subagent_query` | `list` 查看元数据与工作区、`get` 查看实例详情、`result` 读取指定轮次结果 |
| `subagent_reply` | 附具体理由，回答一个当前请求 |
| `subagent_workspace` | 显式 `create` 托管工作树或 `integrate` 待集成改动 |

`subagent_query({action: "list"})` 只返回元信息，不携带结果正文；传 `{action: "get", id}` 可查看当前详情与有界预览。终态报告通知提供 `subagent_query({action: "result", id, runId})` 入口，读取该轮的原始结果。长结果保持两个 ID 不变，将返回的 `nextOffset` 作为 `offset` 继续读取，直到其为 `null`（`limit` 默认及上限为 6000 个 UTF-16 代码单元）。读取结果不会唤醒或恢复代理。

TUI 报告跟随 Pi 的展开/折叠状态（默认 **Ctrl+O**，支持自定义按键）。折叠时只显示一行实例/状态摘要，失败和待处理请求保持醒目；展开后查看通知正文及精确轮次的结果读取入口。旧通知缺少展示元数据时标为 `status unavailable`，不猜测成功状态。待处理请求会持续显示在状态行中，答复后自动消失。常规请求显示“等待主 agent 审核”，不再催你接手；只有需要人工批准的请求才显示操作入口并弹出一条 warning 通知。折叠只改外观，父代理收到的内容和投递收据不变；展开文本会剥除 ANSI/终端控制序列，原始记录不变。

等待请求通过 `steer` 在忙碌主 agent 的下一次模型请求前送达，不终止正在执行的工具。其余批次仍通过 `followUp` 在当前执行结束后送达。主 agent 默认处理普通提问和权限请求；只有上下文、动作效果或授权不清楚，用户明确要求确认，或原生请求确实要求人工时才升级给人。

Pi 子代理每次启动或恢复时会显式加载随包提供的 `subagent_ask_parent`，不要求全局安装问答插件。已识别的调用形成一个逻辑问题，提供 2–4 个选项并允许自定义文本。父代理只需一次通过 `subagent_reply.value` 提交选项标签或实际答案；适配器沿用 Paseo 的流程，缓存答案并自动完成对应的原生选择、输入，不再让父代理操作第二个 UI 步骤或发送新任务。请求标记为 `kind: "question"`、`parentPolicy.text: true`，回答只是任务上下文，不扩大权限。只有调用、版本化标题、预期 UI 阶段和形状均匹配的原生弹窗才会消耗该答案；其他 Pi `select`／`confirm`／`input`／`editor` 对话按原生选项或文本形状单独转发给主 agent，不消耗已缓存的任务答案；不再用按钮文字白名单决定主 agent 能否答复。

Codex 的任务表单（`requestUserInput`，按 CLI 0.159.2 核对）可以包含多道问题。对 `method: "form"`、`parentPolicy.answers: true` 的请求，通过 `subagent_query get` 读取 `fields`，一次提交 `subagent_reply.answers`：每个字段 ID 对应一个字符串数组，如 `{ "<字段ID>": ["原样答案"] }`。遵守选项及 `allowOther`；`[]` 明确跳过该题，`cancelled: true` 取消整张表单。缺少字段会被拒绝，绝不猜选第一项。非阻塞问题不会让子代理进入等待状态，但答案仍绑定原请求和原 turn；已解决、已结束或投递不确定的答复不得重放。

Codex 将这些回答视为可信用户输入，因此只能提供用户已经授权的任务上下文，不能创造新授权。已识别的 `mcp_tool_call_approval_<callId>` 请求只有绑定当前活跃 MCP 操作时，才作为独立的单次许可处理：通过 `subagent_reply.value` 选择 `"Allow"` 或 `"Cancel"`（也可 `cancelled: true`），不能用 `answers`。即使原生提供持久选项，本扩展也只开放这两个选择。独立的 `mcpServer/elicitation/request` 入口只接受明确的 MCP 审批元数据、无输入字段的表单及无歧义的活跃操作关联：用 `confirmed: true` 接受、`confirmed: false` 拒绝，或 `cancelled: true` 取消，不能提交表单答案或持久许可。未知种类、数据／URL 表单和未关联请求仍按 fail-closed 处理；普通问题不得使用主机保留的 `mcp_tool_call_approval*` ID。人工可用 `/agent-reply` 逐题作答；敏感字段会提示输入可见且可能留在日志中，并非掩码输入。

Claude 内置的 `AskUserQuestion`（按 2.1.283 核对）也使用同一个 `answers` 接口，支持 1–4 道选择、文本或数值问题。文本和数值题需要原生扩展提问特性已开启，本扩展不会替你开启。字段 ID 是**完整问题正文**，不是显示用的短标题。`multiSelect: false` 最多提交一个字符串；`true` 可提交多个选项及一个自定义答案；`[]` 跳题，不猜默认值。只有这类完整解析的问题卡片能承接原生 `requires_user_interaction: true`，不能用“批准一次”代替；明确的原生人工限制仍有效。取消会拒绝回答该问题，但不主动中断整轮；答案只是任务上下文，不创造新授权或持久权限。

人工入口会收集整张表单后一次提交；多选菜单可反复切换选项，最后选 **Finish selection**，任一步取消都会丢弃尚未提交的部分答案。预览按纯文本显示，不渲染 HTML；显示用的控制字符会转义，不改动原生答案。文本及数值提示保留，但不做类型强制转换或自动套用默认值。Claude 问答映射经过离线验证；真实 Claude 模型回环仍须另行授权验收。

Pi 和 Codex 支持运行中的 `steer` 消息；运行中的 `followUp` 仅 Pi 支持。Claude 必须等当前任务结束后再续聊。面板仅限 TUI，工具也可用于 RPC/非交互模式。

## 隔离并行改动

让 Pi 为**每项可独立集成的改动创建一个托管工作区**：

1. `subagent_workspace({action: "create"})` 从已提交的 HEAD 创建 detached 工作树。父仓库未提交的文件只报告、**不继承**；要继承，须先检查并取得明确授权，再使用 `includeUncommitted`。
2. 用 `subagent({action: "start", role, task, workspace})` 启动任务。不同工作区可以并行；同一工作区只能有一个活跃实例，释放后可交给另一个实例。
3. 按用户工作流决定何时调用 `subagent_workspace({action: "integrate", workspace})`。插件检查技术安全条件，不判断是否遵循了某种审查流程。
4. 集成后或其他实例同步后，续聊需显式选择 `baseline: "keep"`（沿用工作区当前文件）或 `"sync"`（从父仓库更新）。有未集成或已暂存改动时，sync 会拒绝；后续集成只应用新增量。

集成不改变父仓库的 HEAD、索引和分支。工作树位于 `<仓库>.worktrees/`，不会自动安装依赖或授予信任。共享 `cwd` **不隔离文件**，工作树**不隔离操作系统权限**。

托管工作区需要支持 `check-attr --source` 的 Git（已在 2.50.1 测试）。不支持稀疏检出、未合并索引、子模块、符号链接及 Git LFS 等内容过滤器。清理需明确授权并手动执行；删除前先检查工作树，不要强制删除来绕过拒绝。

## 安全与限制

- **主 agent 处理不等于自动批准。** 主 agent 必须遵守用户原有授权，不得授予会话级或持久权限。Pi 对话按原生响应形状转发，`parentPolicy` 表示传输约束，不代表已获用户授权；`confirmed: true` 也不保证只影响一次动作。对任意 Pi 扩展，不再有按钮文字硬过滤来替代主 agent 的判断。Claude／Codex 的单次审批映射和原生人工专属限制仍强制保留；没有策略的旧记录仍只允许父代理拒绝。人工仍可通过面板或 `/agent-reply <agentId> <questionId>` 介入；投递不代表执行成功。
- **集成写入前会检查冲突**，但崩溃或 I/O 故障仍可能留下部分改动。重试前检查保留的补丁、备份和未完成日志。陈旧锁和崩溃的执行者不会自动恢复；快照、集成和同步期间应暂停外部写入。
- **本地记录可能包含敏感源码。** 会话、日志、快照和备份位于父会话旁的 `<父会话文件>.subagents/`，关闭实例不会删除它们。
- **兼容性有边界。** Pi 是主要的端到端验证对象。Codex 协议按 CLI 0.159.2 核对；Claude 需要 PATH 中有原生 Claude Code >=2.1.283（Windows 为 `claude.exe`）。真实父 Pi → Codex/Claude 编排、实时 TUI 审批/基线对话框及任意崩溃恢复尚未完整验证。

## 开发

```bash
npm run check   # TypeScript 检查
npm test        # 构建并运行全部本地层，不调用模型
npm run test:fast
npm run test:domain
npm run test:acceptance:local
npm run test:list # 只列本地选集，不构建或执行测试
```

入口在模块导入前隔离用户角色配置、清除继承的子代理标记，并串行执行。单域定向检查示例：`npm run test:domain -- workspace.test.mjs`。选层规则、本地范围与实测成本见[测试分层说明](docs/testing.md)。

修改代码后重新构建，并在 Pi 中执行 `/reload`。自动化测试不等于完整终端验收。常规调用以工具说明为准；审批、结果读取、工作区和恢复操作见[操作参考技能](skills/delegate-cli-agents/SKILL.md)。历史通知和会话不重写，可将旧通知中的原实例/run ID 交给新查询工具。

## 致谢

- [Paseo](https://github.com/getpaseo/paseo)：生命周期设计参考；Pi 工具调用与对话的关联逻辑改编自其[固定版本的映射器](https://github.com/getpaseo/paseo/blob/99fc204c55c8c1666477282eeba562ba87a3135f/packages/server/src/server/agent/providers/pi/extensions/rpiv-ask-user-question/index.ts)（Apache-2.0）。Codex 问题归一化与答案映射也改编自其[固定版本的 Codex 适配器](https://github.com/getpaseo/paseo/blob/06fe97c9019c1db4a5264dfb9b369b93e5e2fba4/packages/server/src/server/agent/providers/codex-app-server-agent.ts)，改为按 ID 回答、严格校验，并去掉缺失答案默认选第一项的行为。
- [Lody Codex ACP](https://github.com/LodyAI/acp-extension-codex/blob/60f1dc4bda7d503eb107a9875893a62d399fd97e/src/permissions/mcp.ts)：单次与持久许可分离及[无输入字段 elicitation 的识别](https://github.com/LodyAI/acp-extension-codex/blob/60f1dc4bda7d503eb107a9875893a62d399fd97e/src/CodexElicitationHandler.ts#L361)来源（Apache-2.0），按 [OpenAI Codex rust-v0.159.2](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/mcp_tool_call.rs#L1460) 的 MCP 前缀问题和 elicitation 协议适配，增加活跃操作关联并禁用持久许可；不捆绑 Lody/ACP 运行时。
- [@juicesharp/rpiv-ask-user-question 2.12.0](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question/v/2.12.0)：子 Pi 内置工具的单问题 RPC 选项／自定义回答流程来源（MIT）。
- [pi-subagents](https://github.com/tintinweb/pi-subagents)：状态区与对话界面的设计参考。

复用代码的版权与许可原文集中放在 [README 的致谢折叠区](README.md#credits)，相关源码保留了修改说明。
