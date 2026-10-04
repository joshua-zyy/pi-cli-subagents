# CLI subagent 四工具接口设计

状态：四工具、角色目录和 follow-up 通知已分增量实施，代码基线为 `b406426`。本地验证通过；真实模型及真实 CLI 协作体验尚未验收。

当前范围只包含 Pi 主 agent 使用的 CLI 子代理派发与管理；`@角色` 及用户直接新建派发入口暂缓。保留现有用户管理界面。本文细化产品目标，不构成后续代码修改、真实派发或模型调用的授权。

## 1. 设计结论

采用四个职责分离的工具，角色目录直接进入派发工具说明。保留原生会话、历史结果及工作区身份，不通过删能力来减少工具数量。

| 新工具 | 操作 | 现有能力来源 |
|---|---|---|
| `subagent` | `start` / `send` / `stop` | `spawn_agent` / `send_input` / `close_agent` |
| `subagent_query` | `list` / `get` / `result` | `list_agents` 的三种读取方式 |
| `subagent_reply` | 回答一个指定请求，不需要 action | `respond_to_permission` |
| `subagent_workspace` | `create` / `integrate` | `create_workspace` / `integrate_workspace` |

不新增自动分工、自动复用、模型覆盖、强制审查、自动重试或自动 worktree 策略。工作区工具正常可用，是否调用由用户及其主 agent 决定，不要求用户先打开额外开关。

以下为逻辑参数契约，不是最终 TypeBox/JSON Schema 代码。各 action 有自己的必填字段和允许字段；不适用字段必须拒绝，不能被静默忽略。实现采用根对象 schema，并在执行前补充 action 级字段检查；已通过本地接口测试，不以文档示例或本地通过推断所有模型端点兼容。

## 2. `subagent`：实例生命周期

### 2.1 参数

| action | 必填 | 可选 | 语义 |
|---|---|---|---|
| `start` | `role`、`task` | `cwd` 或 `workspace` | 创建新实例，执行首轮任务；cwd 与 workspace 互斥 |
| `send` | `id`、`message` | `mode`、`baseline`、`includeUncommitted` | 运行中投递指令，结束后在同一原生会话开启新轮次 |
| `stop` | `id` | 无 | 停止活动执行，保留原生会话和历史，不删除文件或回滚改动 |

`start` 默认使用当前 Pi 工作目录；指定 workspace 时由记录解析实际路径。role 必须是当前有效配置中的名称。CLI、provider、model 等从角色配置解析，不开放本轮模型路由参数。task/message 必须非空。

`send.mode` 保持 `steer | followUp`，默认 steer。它控制子代理收取指令，与结果通知主 agent 的投递方式不是同一个设置。

| 目标状态/CLI | `send` 行为 |
|---|---|
| Pi 运行中 | 按指定 steer/followUp 投递；不把接收回执解释为已经执行 |
| Codex 运行中 | 支持的 steer 路径；followUp 明确拒绝 |
| Claude 运行中 | 当前不支持运行中投递，明确拒绝；等待本轮结束后才能续聊 |
| 有未解决的交互请求 | 指向 `subagent_reply` 或用户交互入口，不把普通消息当批准 |
| 已结束且原会话可恢复 | 等旧执行释放，再在同实例中开始新 run |
| 会话缺失、占用不明或状态不确定 | 拒绝并提供诊断线索，不静默新建替代 |

上述 CLI 能力来自当前实现，不承诺上游所有版本永远相同。

恢复契约限定为原生会话身份及已保存历史的恢复，不承诺子 CLI 进程或后台任务始终驻留。结束后 send 可能重新启动 CLI 并加载原会话，不意味着原后台 shell、监听任务或内存状态仍在。原会话不可恢复必须明确失败；进行中执行失联时仍须检查占用与状态，不得借恢复操作重复启动未知写者。

`baseline: keep | sync` 和 `includeUncommitted: { reason }` 仅用于托管工作区。集成或基线变化后继续实例，须显式选择基线；sync 不在活动实例上执行，也不能覆盖未集成改动。reason 记录调用方说明，不等于插件已证明存在用户授权。

### 2.2 返回与错误

沿用现有实例信息：`id`、`runId`、`role`、`cli`、`phase`、`cwd`、已知原生会话身份、待处理请求，以及适用的 workspace / workspaceBaseline。按需附带错误与定位，不回传整个原生配置或凭证。

不要新增一个含糊的 `success: true` 来概括所有状态：

| 结果 | 必须表达什么 |
|---|---|
| 已接收 | 接收范围和当前状态；不保证任务成功 |
| 明确拒绝 | 原因；不能把本次操作说成已派发 |
| 启动/投递确认不明 | 已知实例与 run、记录位置、哪些事实不确定；禁止自动重试 |
| 已结束或已失败 | 原样报告任务状态，不用“已派发成功”遮盖即时失败 |
| stop 已确认 | 旧执行已停止/释放；不代表工作内容已经撤销 |
| stop 未确认 | 保留不确定性与诊断线索，不宣布可安全接管 |

现有 `AgentState.accepted` 表示本轮初始任务的接收状态，不是每次 send 的独立收据。不能用已有 true 值证明新消息已送达。send 的答复依据控制请求的实际结果；不新增未经原生 CLI 支持的“已读/已执行”保证。

### 2.3 示例

```json
{"action":"start","role":"implementer","task":"完成指定改动","workspace":"<workspace-id>"}
```

```json
{"action":"send","id":"<agent-id>","message":"继续处理这个问题","baseline":"keep"}
```

```json
{"action":"stop","id":"<agent-id>"}
```

示例角色名不表示插件必须内置该角色，实际以用户配置为准。

## 3. `subagent_query`：只读查询

| action | 必填 | 可选 | 返回 |
|---|---|---|---|
| `list` | 无 | 无 | 本主会话实例的精简元数据及托管工作区清单，不带报告正文 |
| `get` | `id` | 无 | 指定实例的状态、最近任务历史、待处理请求及有界结果预览 |
| `result` | `id`、`runId` | `offset`、`limit` | 指定 run 的原始最终报告分页 |

保留 `list` 返回工作区清单，是为了发现可复用的工作区及其占用状态，不额外增加第五个列表工具。`get` 可同时提供该实例关联工作区的必要信息；不增加跨主会话扫描。

result 沿用当前分页契约：offset 默认 0；limit 默认/上限 6000 UTF-16 code units；返回 `agentId`、`runId`、`status`、`time`、`error`、`offset`、`totalLength`、`nextOffset`、`text`。固定 id/runId，按 nextOffset 继续，直到 null。

缺失、损坏、跨实例或跨主会话的结果必须拒绝。没有原报告不能替换成当前最新结果；读取不能启动、唤醒、停止实例或批准操作。结果预览和状态结束都不证明业务成果已被认可。

## 4. `subagent_reply`：指定请求答复

保留参数：`id`、`questionId`、`reason` 必填；`confirmed`、`value`、`cancelled: true` 三者恰选一项，并与请求类型匹配。

| 请求类型 | 答复 |
|---|---|
| confirm | confirmed 布尔值，或取消 |
| select | 当前合法选项的 value，或取消 |
| input/editor | value 文本，或取消 |

请求必须属于当前父会话和指定实例，尚未结束或过期。身份来源由工具实现设为 parent，不能允许模型传 `actor: human`。humanOnly 批准留给人类入口；请求允许的拒绝/取消仍可处理。

返回当前状态及“答复已接收”的真实结果，不声称被批准的操作已完成。保留现有本地决定记录。普通 send 不能旁路这套检查。

单独保留此工具，是为了让授权答复与普通生命周期操作可区分；并不把它扩展成自动审批策略。

## 5. `subagent_workspace`：托管 worktree

| action | 必填 | 可选 | 返回 |
|---|---|---|---|
| `create` | 无 | `includeUncommitted: { reason }` | 工作区 id、path/cwd、基线、revision、状态、父目录未提交改动及占用信息 |
| `integrate` | `workspace` | 无 | workspace、status、changedFiles，以及适用的 patchFile |

create 以当前 Pi 工作目录所属仓库为来源；默认基于已提交 HEAD，不悄悄继承未提交改动。是否继承全部当前未提交改动必须明确授权。暂不增加从任意 ref/分支/PR 创建等新能力。

integrate 将该工作区尚未集成的改动应用到原父目录，保留原记录和补丁，不改父目录 index、HEAD 或分支，不自动提交、推送或删除 worktree。返回状态沿用 `applied | already_integrated | no_changes`。

必须保持的技术边界：

1. 工作区归属与仓库身份正确，操作锁和执行占用已检查。
2. 基线与同步记录有效，未完成/不确定操作不能被盲目重试。
3. 应用前检查冲突及父文件变化；已集成的增量不再次应用。
4. 启动或续聊使用同一工作区时经过同样的占用检查；不能通过 raw cwd 绕过已知托管工作区约束。
5. 出错保留足够恢复证据，不自动删除文件、恢复旧基线或强制应用补丁。

工作区生命周期独立于单个 agent：同一个 workspace 可以在先前实例结束后交给另一个实例使用。不自动认定新实例是 reviewer，也不强制某个角色顺序。

源码复核更正：当前 `WorkspaceStore.apply()` 检查占用、仓库、基线、补丁与冲突，但没有读取 reviewer 结果或校验 PASS 的硬门禁。此前“需要独立审查”主要写在工具说明和 skill 中；四工具迁移已中立化这些工作流措辞，保留技术安全检查。

### 并行隔离示例

```text
workspace.create → W1     workspace.create → W2
subagent.start(workspace=W1)  subagent.start(workspace=W2)
             ↓ 各自执行，结果自动返回 ↓
按用户工作流检查成果，再分别 workspace.integrate
```

此处 workspace.* 是文档简写，实际调用 `subagent_workspace(action=...)`。示例不是默认自动流水线；不需要隔离的任务仍可以指定 cwd 或使用当前目录。

## 6. 角色发现与自动返回

`subagent` 的工具说明列出当前有效的角色名与简短 description。不列完整 instructions，不鼓励按模型档位挑选，不要求先 query 才能知道角色。角色配置由插件解析；查询工具用于实例而不是首次角色发现。

目录生成必须遵守项目可信状态与配置优先级。实现在 session_start、before_agent_start 及设置保存后重新注册派发工具说明；不重写全部提示词。已验证配置替换、可信状态变化和无效配置清除旧目录。外部文件在一轮执行中变化时，目录到下一次刷新才更新；启动仍按调用时的有效配置解析。

结果与需处理的阻塞走现有自动通知通道，不需要子代理另调一个“上报工具”。通知绑定原主会话、实例与 run，并提供新的 result 查询入口。原文过长时用预览加全文分页，不删证据。

通知语义：主 agent 空闲时可触发处理，忙碌时 follow-up 排队，不插入 steering。`deliverReports` 已改用 followUp；不能把它与 `subagent.send.mode` 混为一谈。队列不是持久回执，原主会话恢复后可补交未记录通知，已记录通知按 ID 去重；这不是所有异常下的恰好一次交付保证。

插件不决定主 agent 收到后必须继续实施、审查或集成。当前阶段不新增通用子→主主动消息工具。

## 7. 迁移策略与验证门槛

不同时向模型暴露新四工具和旧七工具。同步更新工具说明、skill、通知中的结果读取提示及相关测试；不增加仅为保持旧工具名称而长期并存的入口。

原始会话、实例 ID、run ID、角色快照和工作区记录继续保留，不为改工具名创建新实例或改写旧报告。旧通知中的旧工具调用提示仍是历史原文；使用指南应给出名称映射，模型可按原 id/runId 调新查询入口，不修改旧证据。

| 验证范围 | 必须证明 |
|---|---|
| 工具定义 | 只暴露四个；角色目录是当前有效配置；按 action 校验；未知/不适用字段拒绝 |
| 生命周期映射 | 新建是新实例，send 续接原身份；不支持模式明确失败；超时/拒绝不自动替代 |
| 查询与答复 | 查询无执行副作用；完整结果可还原；答复归属、过期、类型、humanOnly 不回归 |
| 工作区 | 两个实例各用一个 worktree；同 workspace 串行交接；冲突拒绝、增量集成和基线续聊保持正确 |
| 通知与兼容 | 原主会话接收；忙碌 follow-up；恢复补交；旧实例和旧 run 可读；历史通知不改写 |

角色可覆盖但当前不能移除内置角色、启动确认不明的回执、损坏报告影响同批通知等问题，与合并工具不是一回事。先以反例核查，独立列增量，不把所有可靠性修补塞进工具改名。

四工具迁移时测得 name/description/parameters 的 JSON 从 6,279 降至 5,147 字节；该测量在加入动态角色目录前完成，不是最终 token 数。4 比 7 少，不代表更容易正确调用。继续优先用本地测试与伪 CLI 验证，真实调用另行授权。

## 8. 当前证据与未验证项

已对照 `src/index.ts`、`src/types.ts`、`src/manager.ts`、`src/notifier.ts`、`src/worker.ts`、`src/roles.ts`、`src/workspace.ts` 和现有 skill 的契约。本草案没有新增运行时类型、状态表、数据库或队列实现。

实施提交：`4b46bdc`（四工具迁移）、`29de2e4`（有效角色目录）、`b406426`（follow-up 通知）。截至该基线，全量本地测试 385/385、typecheck/build 通过；项目依赖与实际安装 Pi 的加载器刷新探针通过。通知测试使用真实 SDK 路由方法配合受控执行桩，覆盖忙碌排队、丢失队列后的原 run 补交与持久回执去重，不等于完整模型循环验收。

未运行真实模型、真实 CLI 协作或独立代理审查；@派发、多入口新增行为和真实端点兼容性仍未验证。

下一步：重载扩展检查工具与角色目录；真实协作体验验收须另获授权。
