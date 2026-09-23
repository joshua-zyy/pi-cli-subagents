# pi-cli-subagents

为 Pi 提供轻量、本地的 CLI 子代理管理能力。主 agent 使用工具派发和管理真实 CLI 会话，skill 指导任务拆分与调度；扩展不内置自动工作流系统。

## 第一阶段范围

1. 先打通 **Pi → Pi**：异步派发、中途追加、状态与实例发现、停止/关闭、完成汇报。
2. 保留稳定子代理身份和原生会话；本轮完成后可再次调用同一子会话。
3. 运行中的子任务不因主 Pi 退出而取消；完成后允许释放进程，保留结果与会话供恢复。
4. 审查使用独立会话，不自动创建 worktree；共享目录时由主 agent 协调，避免冲突写入。
5. 沿用 CLI 已有模型和权限配置；无法自行处理的审批或交互明确报告“等待处理”，不自动扩大权限。

运行中的实例应重连，已释放的实例应恢复原 session，不能静默新建或重复执行。主 Pi 离线时只继续已收到的任务；后续调度仍由主 agent 决定。

第一阶段不接入 Codex/Claude，不建设多端平台、全局常驻服务、工作流 DSL、额外子代理展示界面或 token 预算机制。

## 验收目标

主 Pi 派发实施子代理 A，完成后派发独立审查子代理 B，再把问题发回原 A 会话继续修复。另需验证主 Pi 退出后的任务存活、恢复连接和完成结果补交。

## 本地开发和加载

```bash
npm ci
npm test
# 本地试用：在目标工作目录运行，**不会安装到全局设置**
pi --extension D:/AI/agentBySelf/pi-extensions/pi-cli-subagents/dist/index.js \
   --skill D:/AI/agentBySelf/pi-extensions/pi-cli-subagents/skills/delegate-cli-agents
```

也可将仓库作为 Pi 本地 package 显式安装（会写入相应范围的 Pi settings；安装前先自行确认）。运行时需要 Node >=22.19，仓库内 `dist/` 为本机构建产物，不提交 Git；打包时由 `prepack` 构建。

第一版提供 `spawn_agent`、`send_input`、`list_agents`、`close_agent` 四个模型工具。原生 Pi 没有默认权限审批；仅当其它扩展使子 Pi 发出交互请求时，才会上报“等待处理”，由用户选择是否通过可选的 `/agent-reply <agentId> <questionId>` 回复，绝不自动批准。运行中的 `send_input` 可选 `steer` 或 `followUp`；完成后的 `send_input` 恢复同一子 Pi 会话。`close_agent` 停止当前任务，不删除会话文件。主会话必须持久化（不能用 `--no-session`），结果只回到创建它的原主会话。

角色内置 `worker` 和 `reviewer`。可选角色覆盖文件：用户级 `~/.pi/agent/cli-subagents.roles.json`，受信项目的 `.pi/cli-subagents.roles.json`。每个角色需要 `description`、`instructions`，可选 `provider`、`model`、`thinking`；缺省模型与权限均由原 Pi CLI 配置决定。示例：

```json
{
  "tester": {
    "description": "独立验证",
    "instructions": "检查指定代码并报告可复现的问题，不要自行修改代码。"
  }
}
```

子会话、结果和运行日志与主会话文件相邻，位于 `<主会话文件>.subagents/`；这些内容可能含敏感任务文本，勿上传或加入版本控制。共享 `cwd` 不等于独立文件系统；审查期间不要让写代理同时修改同一文件。无法处理的交互显示为等待处理，只有用户能通过 `/agent-reply` 回复。离线完成报告由原主会话重新打开后补交，未打开时保存在本地。

## 验证与边界

`npm test` 使用假 Pi RPC 子进程，不消耗模型额度。`node test/real-smoke.mjs` 是**需明确选择运行**的真实 Pi 测试（通常两次小模型调用），产物仅写 `.test-output/`。已用真实主 Pi（临时加载扩展的 RPC 模式）依次派发实施和独立审查、退出并恢复原主会话、将审查结果送回同一个实施实例和原生 session；恢复后仅补交新报告，再次恢复未重复投递。这次端到端验收的临时页面、驱动脚本、原始会话及日志均只留在本地，不进入版本控制或安装包。**尚未验证**主 Pi TUI 退出后补交和执行端自身崩溃恢复。其它扩展触发交互时使用的 `/agent-reply` 真实 TUI 对话框也尚未实测，但这是可选兼容路径，**不阻塞首版 Pi→Pi 实施—审查—再实施的验收**；本次权限请求由用户明确选择后通过控制协议转交，而非 TUI 命令。出现执行端不可达或残留锁时会拒绝在同一会话上重复启动，需要人工检查日志，不会自动清锁抢占。

前期独立协议/生命周期探针仍保留在本机 `D:/AI/piTest`（见 `docs/findings-pi-lifecycle.md`），原始会话、日志和测试凭证不作为项目源码提交。
