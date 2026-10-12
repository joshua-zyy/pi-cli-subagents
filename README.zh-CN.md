# pi-cli-subagents

[English](README.md)

一个 Pi 扩展，让主 agent 把任务交给 Pi、Codex 和 Claude Code 子代理。

支持独立任务并行执行、结果与问题自动回到原主会话，以及复用同一个子会话继续工作。需要隔离并行改动时，可使用托管 Git 工作树。

内置 `explore`、`worker`、`reviewer`、`oracle` 四个角色，默认使用 Pi；未配置模型时继承主 agent 的模型。角色、后端和工作流由你决定。

用 `/agents` 查看和管理会话，用 `/cli-agents-setting` 配置角色。

## 文档

- [操作参考](skills/delegate-cli-agents/SKILL.md)
- [工具接口](docs/subagent-tool-contract.md)
- [开发与测试](docs/testing.md)

## 致谢

参考项目、复用代码的版权与许可证原文见 [Credits](README.md#credits)。
