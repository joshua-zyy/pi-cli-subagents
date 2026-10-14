# pi-cli-subagents

[English](README.md)

![pi-cli-subagents](https://raw.githubusercontent.com/joshua-zyy/pi-cli-subagents/main/docs/assets/readme-banner-v3.png)

把任务从 Pi 会话委派给可长期存活的 Pi、Codex CLI 与 Claude Code 子代理。

每个子代理保有各自的原生会话与进程生命周期，因此主 agent 可以并行跑多个任务、在它们运行时继续
工作，并在之后接着同一条对话继续，而不必重述上下文。提问与结果都会回到发起它的那个会话。需要
并行改动彼此隔离时，可用托管 Git 工作树。

## 环境要求

- Pi，已在 0.87.1 与 1.1.0 上验证
- Node.js 22.19.0 或更高
- 使用 Codex 或 Claude Code 子代理时，需要对应 CLI 已安装并登录；Pi 子代理无需额外依赖

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

## 工具

| 工具 | 用途 |
| --- | --- |
| `subagent` | 对实例执行 `start`、`send`、`interrupt`、`stop`；用 `workspace_create` 与 `workspace_integrate` 管理托管工作树 |
| `subagent_query` | 对本会话的实例做只读的 `list`、`get`、`result`、`activity` |
| `subagent_reply` | 回答一个待处理的任务提问，或在用户授权范围内审阅一项权限请求 |

Pi 子进程可通过 `subagent_ask_parent` 向主 agent 提出一个任务问题。

## 需要了解的行为

- **结果会自动送达。** 完成、失败与等待报告都会送到发起该实例的会话；主 agent 正忙时，报告会在
  它下一次模型请求前送达，且不取消正在运行的工具。无需轮询。
- **回执不等于执行。** `accepted` 只表示原生 CLI 已接收输入，不表示模型已读取或任务已成功。声称
  成功前请读报告与实际文件。
- **会话持久，进程不必持久。** 实例保留原生会话、历史与结果，`send` 会继续同一条对话；`stop`
  释放进程但不删除这些历史。后端是否在轮次之间驻留，按实例如实报告，不作统一承诺。
- **回答不构成授权。** 回复只提供任务上下文，或审阅一项请求，绝不放宽为会话级或持久权限。
- **工作树是隔离，不是沙箱。** `workspace_create` 从已提交的 HEAD 建一个 detached 工作树，
  `workspace_integrate` 只应用待集成的改动，遇冲突则拒绝而不是代为解决。你的 HEAD、索引与分支
  不受影响，也不会自动提交或推送。
- **停止不等于回滚。** 结果不确定时会如实标记为不确定，也不会悄悄用新会话替换原生会话。

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
的审批、任务提问、原会话恢复以及托管工作树集成，这些轮次可以用只读方式回放。尚未在 Linux 或
macOS、完整交互式 TUI 上执行，也未针对最新 CLI 版本执行，本机版本已越过这些轮次记录时的版本。
请把本地通过理解为对仓库内部逻辑的结论，而不是对你所安装 CLI 的结论。

## 致谢

被改编的第三方代码与完整许可证原文见 [NOTICE](NOTICE)。涉及项目为 Paseo 与 Lody（均为
Apache-2.0）、`@juicesharp/rpiv-ask-user-question`（MIT），以及作为状态与对话 UI 灵感的
[tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)。

## 许可证

本扩展自有代码使用 [MIT](LICENSE)。第三方声明见 [NOTICE](NOTICE)。
