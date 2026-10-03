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

> 先让 explore 子代理定位测试失败的原因，不要改文件。再让 worker 修复，交给另一个 reviewer 独立审查。需要修改时继续找原来的 worker，最后报告验证结果。

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

## 查看与续聊

输入 **`/agents`** 或按 **Ctrl+Alt+A** 打开面板。用 **↑/↓** 选择实例，**Enter/v** 查看实时对话，**s** 发消息或恢复，**r** 回答请求，**x** 停止。关闭查看器不会停止子代理。首次打开先显示有限的尾部预览，再在后台补齐历史和统计；统计完成前不展示部分累计值，较早的流式消息上下文也可能随后补齐。期间仍可翻阅、查看状态、发消息或停止。向上翻阅会暂停跟随，按 **End** 恢复。查看器最多保留 300 个展示条目，更早的内容仍在原始事件日志中。

| 父代理可用工具 | 用途 |
| --- | --- |
| `spawn_agent` | 按角色启动任务，指定 `cwd` 或 `workspace`，不能同时指定 |
| `send_input` | 在同一实例的原会话中继续工作 |
| `list_agents` | 查看实例、历史、角色和未决请求；按需读取指定轮次的结果，不用于轮询完成状态 |
| `close_agent` | 停止当前工作，保留会话 |
| `create_workspace` | 创建托管 Git 工作树 |
| `integrate_workspace` | 将已审查的工作区改动应用到父目录 |
| `respond_to_permission` | 附具体理由，回答一个当前请求 |

`list_agents()` 只返回元信息，不携带结果正文；传 `{id}` 可查看当前详情与有界预览。终态报告通知提供 `list_agents({id, runId})` 入口，读取该轮的原始结果。长结果保持两个 ID 不变，将返回的 `nextOffset` 作为 `offset` 继续读取，直到其为 `null`（`limit` 默认及上限为 6000 个 UTF-16 代码单元）。读取结果不会唤醒或恢复代理。

TUI 报告跟随 Pi 的展开/折叠状态（默认 **Ctrl+O**，支持自定义按键）。折叠时只显示一行实例/状态摘要，失败和待处理请求保持醒目；展开后查看通知正文及精确轮次的结果读取入口。旧通知缺少展示元数据时标为 `status unavailable`，不猜测成功状态。折叠只改外观，父代理收到的内容和投递收据不变；展开文本会剥除 ANSI/终端控制序列，原始记录不变。

Pi 和 Codex 支持运行中的 `steer` 消息；运行中的 `followUp` 仅 Pi 支持。Claude 必须等当前任务结束后再续聊。面板仅限 TUI，工具也可用于 RPC/非交互模式。

## 隔离并行改动

让 Pi 为**每项可独立集成的改动创建一个托管工作区**：

1. `create_workspace({})` 从已提交的 HEAD 创建 detached 工作树。父仓库未提交的文件只报告、**不继承**；要继承，须先检查并取得明确授权，再使用 `includeUncommitted`。
2. 用返回的 `workspace` ID 启动 worker。完成后，在**同一工作区**启动独立 reviewer。同一工作区同时只能有一个活跃实例。
3. 审查结束后，让原 worker 处理必要修改。只集成已审查的改动，再在父目录验证结果。
4. 集成后或其他实例同步后，续聊需显式选择 `baseline: "keep"`（沿用工作区当前文件）或 `"sync"`（从父仓库更新）。有未集成或已暂存改动时，sync 会拒绝；后续集成只应用新增量。

集成不改变父仓库的 HEAD、索引和分支。工作树位于 `<仓库>.worktrees/`，不会自动安装依赖或授予信任。共享 `cwd` **不隔离文件**，工作树**不隔离操作系统权限**。

托管工作区需要支持 `check-attr --source` 的 Git（已在 2.50.1 测试）。不支持稀疏检出、未合并索引、子模块、符号链接及 Git LFS 等内容过滤器。清理需明确授权并手动执行；删除前先检查工作树，不要强制删除来绕过拒绝。

## 安全与限制

- **审批仅针对单次动作。** 扩展不提供会话级或持久权限授权。`humanOnly` 请求必须由人通过面板或 `/agent-reply <agentId> <questionId>` 回答；父代理可以拒绝/取消，不能批准。批准不代表执行成功。
- **集成写入前会检查冲突**，但崩溃或 I/O 故障仍可能留下部分改动。重试前检查保留的补丁、备份和未完成日志。陈旧锁和崩溃的执行者不会自动恢复；快照、集成和同步期间应暂停外部写入。
- **本地记录可能包含敏感源码。** 会话、日志、快照和备份位于父会话旁的 `<父会话文件>.subagents/`，关闭实例不会删除它们。
- **兼容性有边界。** Pi 是主要的端到端验证对象。Codex 协议按 CLI 0.159.2 核对；Claude 需要 PATH 中有原生 Claude Code >=2.1.283（Windows 为 `claude.exe`）。真实父 Pi → Codex/Claude 编排、实时 TUI 审批/基线对话框及任意崩溃恢复尚未完整验证。

## 开发

```bash
npm run check   # TypeScript 检查
npm test        # 构建并运行确定性测试，不调用模型
```

修改代码后重新构建，并在 Pi 中执行 `/reload`。自动化测试不等于完整终端验收。详细的代理协作流程见[委派技能](skills/delegate-cli-agents/SKILL.md)。

生命周期管理参考 [Paseo](https://github.com/getpaseo/paseo)，状态区与对话界面参考 [pi-subagents](https://github.com/tintinweb/pi-subagents)。
