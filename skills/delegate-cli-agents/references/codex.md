# codex 后端

## 追加输入与中断

运行中仅支持 `steer`，不支持 `followUp`；确需后续任务时等待自动完成报告，再向空闲实例 `send`。不要靠失败调用探测限制。空闲续轮及释放后恢复仍保留原生会话。

独立中断捕获的当前轮并等待原生结束，保留运行时；不是停止进程。以实例能力和回执为准，不把受理当成任务成功。

## 任务问题

若原生 `request_user_input` 在 Default 模式不可用，核对角色与实际版本/配置。角色字段 `defaultModeQuestions: true` 显式开启经 0.159.2 核对的实验特性，`false` 关闭，省略/UI inherit 沿用原生配置；它不切换 Plan、不授权，也不覆盖禁用的 `tools.experimental_request_user_input.enabled`。

配置新实例须在用户授权内；修改角色不改变已有实例保存的设置。不能通过扩大权限、改全局配置或静默创建替代实例绕过限制。

`form` 且 `parentPolicy.answers: true` 时，读取完整 `fields`，将精确字段 ID 映射到答案数组，遵守必填与选项约束；不以显示标题替代 ID，不与 `value`/`confirmed` 混用。

异步 `agentMessage` 也可能产生非阻塞问题，字段 ID 为索引且必填。仍通过 `subagent_reply` 回答：适配器仅向捕获的活动轮发送关联答案，不开启空闲 follow-up。取消只是本地撤销该问题；轮次结束则请求失效。它不是 RPC 审批。答案被视为可信用户输入，只提供已授权上下文。

## 原生权限与 MCP 请求

关联到活动 MCP 调用的 `mcp_tool_call_approval_<callId>` 是权限请求，不是任务表单。核对 server/tool/arguments，按提供的 `value` 原文 Allow/Cancel 或取消，并写理由；不提交 `answers` 或永久授权。

独立 MCP elicitation 仅在明确审批元数据、仅消息表单与同 server 的活动调用唯一关联时使用确认：`confirmed: true` 接受、false 拒绝、`cancelled: true` 取消。不提交表单数据或持久化元数据。未关联/歧义请求、数据或 URL 表单及未知权限保持拒绝，保留 ID 属于宿主，不尝试绕过。

其他权限请求使用当前 `parentPolicy` 的精确答复，不从旧请求猜形态。敏感字段可能仍在原生日志中，不编造或暴露秘密；投递不确定时不要重复或改发普通消息。
