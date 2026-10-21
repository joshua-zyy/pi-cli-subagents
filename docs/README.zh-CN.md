# pi-cli-subagents

[English](../README.md)

![pi-cli-subagents](https://raw.githubusercontent.com/joshua-zyy/pi-cli-subagents/main/docs/assets/readme-banner-v3.png)

为 Pi 补上子代理派发工具：将工作交给保留原生会话的 Pi、Codex CLI 或 Claude Code 子代理，并将结果送回发起它的父会话。

每个子代理保有各自的原生会话与进程生命周期，因此主 agent 可以并行跑多个任务、在它们运行时继续
工作，并在之后接着同一条对话继续，而不必重述上下文。提问与结果都会回到发起它的那个会话。
子代理可使用当前目录或指定已有 `cwd`；目录隔离与 Git 工作流由用户和 agent 自行决定。

## 环境要求

- Pi，已在 0.87.1、1.0.1、1.1.0、1.2.0 与 1.3.0 上验证加载与注册
- Node.js 22.19.0 或更高
- 使用 Codex 或 Claude Code 子代理时，需要对应 CLI 已安装并登录；Pi 子代理无需额外依赖
- Claude Code 当前仅接受 `2.1.x` 且补丁号至少为 `283`，并检查运行时协议能力；更高的次版本或主版本也须重新验证后才能开放。

worker 升级不保留执行兼容：本版只控制和续跑协议 v3 的实例。升级前请先用旧扩展正常释放已有子代理，再重新加载父扩展。v1/v2 记录仅供只读查询，不迁移、不续跑、不强制接管；仍在运行的旧进程须核对身份后人工清理。

## 安装

```bash
pi install npm:pi-cli-subagents
```

从已执行过 `npm run build` 的本地检出安装：

```bash
pi install ./path/to/pi-cli-subagents
```

`pi install` 写入个人设置；加 `-l` 可只写入当前项目。用 `pi list` 查看已安装内容，用
`pi -e npm:pi-cli-subagents` 试跑一次而不保存。

目前不支持从 Git URL 安装：仓库不提交 `dist/`，而 Pi 安装时不会构建，因此 Git 安装得到的包没有
入口文件。请使用 npm 或已构建的本地检出。

## 角色

内置四个默认角色：

| 角色 | 默认职责 |
| --- | --- |
| `explore` | 调研代码并报告结论，不修改项目文件 |
| `worker` | 实现任务并验证改动 |
| `reviewer` | 在独立上下文中审查指定改动 |
| `oracle` | 依据交给它的材料回答问题或给出判断 |

四者默认使用 Pi，未配置时继承主 agent 的模型。角色是启动模板：CLI、模型、provider、thinking
档位、effort、权限模式与指令。用 `/cli-agents-setting` 定义或覆盖角色。工具与 UI 不依赖内置
角色名，所以这四个是可替换的默认值，而不是固定层级。

## 委派深度

子代理不能通过本插件或后端原生委派工具再派孙代理，不提供开启选项。`allowSubagents: true` 明确拒绝，旧配置中的 `false` 仅作兼容。此限制不是操作系统沙箱，不能阻止保留任意 shell 权限的代理自行启动所有类型的外部程序。

升级前先中断并释放旧运行时，移除角色配置中的 true。保存了 true 的旧实例保留查询、中断和释放，但拒绝 send 及所有公开 reply；取消问题也可能解阻塞而继续旧任务。不会静默改写记录或自动停止旧进程。

## 工具

| 工具 | 用途 |
| --- | --- |
| `subagent` | 对实例执行 `start`、`send`、`interrupt`、`stop`、`reclaim` |
| `subagent_query` | 对本会话的实例做只读的 `list`、`get`、`result`、`activity` |
| `subagent_reply` | 回答一个待处理的任务提问，或在用户授权范围内审阅一项权限请求 |

Pi 子进程可通过 `subagent_ask_parent` 向主 agent 提出一个任务问题。

## 需要了解的行为

- **结果会自动送达。** 完成、失败与等待报告都会送到发起该实例的会话；主 agent 正忙时，报告会在
  它下一次模型请求前送达，且不取消正在运行的工具。无需轮询。
- **回执不等于执行。** `accepted` 只表示原生 CLI 已接收输入，不表示模型已读取或任务已成功。声称
  成功前请读报告与实际文件。
- **会话持久，进程不必持久。** 实例保留原生会话、历史与结果，`send` 会继续同一条对话；`stop`
  释放进程但不删除这些历史，并会拒绝释放「已受理的一轮仍在进行」的实例：释放该运行时会丢弃这一轮，
  需先 `interrupt`。后端是否在轮次之间驻留，按实例如实报告，不作统一承诺。
- **回答不构成授权。** 回复只提供任务上下文，或审阅一项请求，绝不放宽为会话级或持久权限。
- **工作目录由你选择。** `start.cwd` 接受已有目录，包括自行管理的 worktree；扩展不创建、同步、
  合并、锁定或删除目录。不同 cwd 不是权限沙箱，多个使用者共享文件时仍须自行协调。
- **停止不等于回滚。** 结果不确定时会如实标记为不确定，也不会悄悄用新会话替换原生会话。

## 托管工作区退役

已移除 `workspace_create`、`workspace_integrate` 及 `workspace`、`baseline`、`includeUncommitted`
输入，不保留别名；实例查询不再返回工作区清单。新实例仅使用 `cwd`，不提供 worktree 专用 skill 或自动 Git 流程。

旧托管实例保留历史和基线元数据，但所有状态下的 `send` 均明确拒绝，不会静默绕过原基线检查。
当前协议下的答复、中断和释放仍可使用；答复可能让已受理任务继续执行。明确采用旧目录前，先释放旧
使用者，检查保留的 journal、patch 和 backup，特别是未决集成；不自动迁移、删除或应用任何内容，
也不要另起实例绕过拒绝。详见[迁移合同](subagent-tool-contract.md#5-working-directories-and-legacy-managed-records)。

## 会话内界面

主 agent 回复下方只显示 starting/running/waiting/stopping 的工作；没有进行中或待回复工作时整块消失。空闲实例与已结束结果仍保留在 `Ctrl+Alt+A` 打开的 `/agents` 管理面板中，隐藏不等于释放进程。下方状态截图来自此次过滤改动之前。

![主 agent 回复下方的实例列表](https://raw.githubusercontent.com/joshua-zyy/pi-cli-subagents/main/docs/assets/subagent-running-ui.png)

`/agents` 是输入框上方的固定面板，不是浮层；随终端尺寸伸缩，列表在面板内部滚动，打开期间隐藏重复的活动摘要。它仍可浏览同一批实例、打开对话并释放空闲运行时。下图来自固定面板改动之前。

![`/agents` 面板](https://raw.githubusercontent.com/joshua-zyy/pi-cli-subagents/main/docs/assets/subagent-panel.png)

对话视图显示发出的任务与回来的回复，面板底部列出当前可用按键。

![单个实例的对话](https://raw.githubusercontent.com/joshua-zyy/pi-cli-subagents/main/docs/assets/subagent-detail.png)

## 命令与按键

| 入口 | 用途 |
| --- | --- |
| `/agents` | 浏览实例、对话与结果；在面板中回复、中断或释放 |
| `/cli-agents-setting` | 在编辑器上方面板中配置角色 |
| `Ctrl+Alt+A` | 主 agent 工作时打开实例列表 |
| `/agents` 内 | `i` 详情、`r` 回复、`t` 中断、`x` 释放空闲实例、`c` 批量释放空闲实例、`h` 历史 |

派发通过主 agent 的工具与该面板进行，暂无 `@role` 提示词快捷方式。

## 文档

- [操作参考](skills/delegate-cli-agents/SKILL.md)，随包分发：主 agent 如何回答提问、处理审批、
  读取分页或截断的结果，以及如何从不确定操作中恢复
- [工具接口](https://github.com/joshua-zyy/pi-cli-subagents/blob/main/docs/subagent-tool-contract.md)
- [开发与测试](https://github.com/joshua-zyy/pi-cli-subagents/blob/main/docs/testing.md)

## 验证状态

本地测试套件在完全不调用模型的情况下通过。真实 CLI 与模型验收已记录八轮，覆盖 Codex 与 Claude
的审批、任务提问、原会话恢复以及现已退役的托管工作树集成。这些历史轮次可以只读回放，但不构成
新 cwd-only 接口的验收。

另一次 Windows / Pi 1.3.0 真实任务验证了 cwd-only 接口：父 Pi 自行用 Git 隔离，Pi 子代理在同一原生
会话内驻留续跑两轮，父级确认释放后集成、重跑测试并清理目录，全程未加载 worktree 专用 skill。
这是一条行为见证，不是可靠性或成本基准。

后续 Windows 真实问答验收使用 Pi 1.3.0 父代理及 Pi、Codex CLI 0.162.1 子代理，各在原会话内驻留两轮。
父代理在首次控制前读取对应后端说明，通过各自答复形态处理真实任务问题，未读取未使用的 Claude 说明。
两运行时均已释放，临时测试配置已恢复。这只证明一条问答与续聊路径，不证明普遍遵从或节省 token；
Claude、运行中消息/中断时序、释放后恢复、权限审批、人工 TUI 和 Linux/macOS 不在本轮覆盖范围。

## 致谢

被改编的第三方代码与完整许可证原文见 [NOTICE](NOTICE)。涉及项目为 Paseo 与 Lody（均为
Apache-2.0）、`@juicesharp/rpiv-ask-user-question`（MIT），以及作为状态与对话 UI 灵感的
[tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)。

## 许可证

本扩展自有代码使用 [MIT](LICENSE)。第三方声明见 [NOTICE](NOTICE)。
