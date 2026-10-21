---
name: delegate-cli-agents
description: Read backend-specific rules before sending, interrupting or replying to a CLI subagent; handle approvals, paged results and uncertain recovery.
---

# CLI 子代理操作参考

角色与协作流程由用户和父代理决定，不规定固定角色顺序或报告模板。

## 操作前按实例取知识

从工具响应读取实例的 `cli`、`runtimeId` 和 `capabilities`。身份或能力不在上下文中时，用 `subagent_query get` 核对；查询不启动进程。不要从角色名或当前角色配置猜测已有实例的后端。

首次向某一后端发送追加输入、中断或答复前，读取本目录下的 `references/<cli>.md`，用实例返回的 `cli` 替换 `<cli>`。只读该后端，不遍读其他后端；已经读过且仍适用时复用，不要求每次操作重新读取。

`capabilities.busySendModes` 是运行中支持的发送模式；`interrupt` 是独立中断支持。`null` 表示尚无证据，空数组或 `false` 表示不支持；不要调用一次来试探。能力绑定当前运行时，新运行时须重新确认；它既不是当前可操作状态，也不代表授权。空闲实例的 `send` 开始新轮，不是运行中追加输入。

答复以当前请求的 `parentPolicy`、`method` 和 `fields` 为准，不能从实例能力或旧问题推断。支持某种答复不意味着用户授权该动作。

## 按问题取通用规则

| 情况 | 参考 |
| --- | --- |
| 子代理提问或请求权限 | [审批与答复](references/approvals.md)，并读取当前后端说明 |
| 结果截断、报告迟到或父会话重开 | [结果与投递](references/recovery.md#results-and-delivery) |
| 中断、释放、恢复失败、状态不确定或人工介入 | [恢复](references/recovery.md) |

使用可持久化的父会话；不支持 `--no-session`。同目录的另一会话不会接管实例或报告。

不确定时先核对保留的状态、日志和结果，不能盲重试、改写记录或另起实例绕过拒绝。报告和人工操作记录不扩大原授权。
