# 本地测试分层与验证成本

## 入口与边界

现有 Node 测试设施不变；`scripts/test.mjs` 负责本地选集、导入前环境隔离和串行执行。以下计数及成本记录是分层建立时（`bf85d3e`）的基线：原有 45 个文件、385 条测试保留，另加 5 条启动器测试，共 390 条。后续新增回归测试不改写历史测量值，当前计数以实际运行输出为准。

| 入口 | 文件 / 测试数 | 范围 |
|---|---:|---|
| `npm run test:fast` | 26 / 239 | 不启动 CLI/Git 的逻辑、UI、结果投影与转录读取；可读写临时文件 |
| `npm run test:domain` | 6 / 62 | 单模块协议/适配器、RPC、存储竞争、Git 工作区与测试启动器；只用本地 fixture |
| `npm run test:acceptance:local` | 14 / 89 | manager、扩展入口、UI 操作、授权与恢复的本地闭环；CLI 使用 fixture |
| `npm test` | 46 / 390 | 上述三个本地选集的并集，不包含真实模型验收 |
| `npm run test:list` | 不执行测试 | 输出全部本地文件清单及未运行的真实验收提示 |

运行入口先构建 `dist/`；`test:list` 不构建。已有最新构建时可直接运行 `node scripts/test.mjs fast`。

具体文件归属以 [`scripts/test-tiers.json`](../scripts/test-tiers.json) 为准。每个正式 `.test.mjs` 文件必须且只能归一层；重复、遗漏、文件缺失或非测试文件条目都会在测试导入前失败，不默默跳过。

```bash
# 列出某层，不执行
node scripts/test.mjs domain --list

# 只运行该层中的指定文件（不会暗中补跑快层）
npm run test:domain -- workspace.test.mjs
npm run test:acceptance:local -- extension.test.mjs tool-receipts.test.mjs
```

越层文件、未知层、任意路径和 `real-smoke.mjs` 均不接受。`test/real-smoke.mjs` 等真实模型脚本不纳入这些入口；输出会明确标记 **NOT_RUN**。它们原有的独立调用方式不变，执行前仍须获得用户明确授权。本地 PASS 不代表真实 CLI、模型、操作系统崩溃或人工 TUI 体验已验收。

## 环境隔离

每次执行创建临时 `PI_CODING_AGENT_DIR`，在子进程模块导入前生效，避免用户的 worker 角色配置把 Pi fixture 改派给真实 Codex/Claude；同时清除继承的 `PI_CLI_SUBAGENT`，避免扩展注册提前退出。真正的子代理递归保护仍保留，测试没有禁用它。

Node runner 使用 `--test-concurrency=1`；不修改父进程环境或用户全局配置。正常完成及失败退出均清理该临时 home，并保留测试退出码。此入口不是操作系统沙箱，也不承诺强杀或断电后自动清理临时目录。

启动器测试通过独立的微型仓库验证真实进程边界。内层 runner 启动前只在测试夹具中移除 `NODE_TEST_CONTEXT`，避免 Node 把它误判为外层测试的递归运行并静默跳过。

## 选层规则

1. 日常修改跑快层，再跑相关域文件；`src/index.ts`、通知/回执等公共入口改动还需对应本地闭环。
2. 修改 native CLI 适配器，跑对应适配器域测试及 manager/workspace 本地闭环；不因此自动获得真实模型调用授权。
3. 无 CI 的收尾至少跑快层和域层全量；共享 schema、跨层契约或测试入口改动使用 `npm test` 做完整本地回归。
4. 新增测试先更新清单；按实际依赖分类，不按文件名字猜测。当前仍保留少量混层文件，例如 `core.test.mjs` 和 `tool-receipts.test.mjs`，不为分层重构其内容。
5. 快层墙钟暂以 20 秒为复核阈值，而非失败门禁。超过阈值先核机器负载、依赖和层归属，不为卡时间或条数删除安全覆盖。删并需单独的反例/变异证据。

## 成本记录

以下为本次 Windows / Node 22.21.0 上逐项独立执行的实测值；各入口均包含一次构建。全部通过，skipped=0；真实 CLI/模型验收均为 NOT_RUN。

| 入口 | 通过 / 总数 | 含构建墙钟 | Node runner 时间 |
|---|---:|---:|---:|
| `npm run test:fast` | 239 / 239 | 15.62 秒 | 11.96 秒 |
| `npm run test:domain` | 62 / 62 | 59.13 秒 | 55.36 秒 |
| `npm run test:acceptance:local` | 89 / 89 | 153.27 秒 | 149.60 秒 |
| `npm test` | 390 / 390 | 220.77 秒 | 217.09 秒 |

分层减少日常选集的验证成本，不声称完整套件被加速。全量的 220.77 秒是独立运行值，不是三层时间相加；本地日志位于被忽略的 `.test-output/tiers-*.log` 和 `tiers-timings.json`。环境、测试变化后需重新测量，不能把这张表当作持续有效的性能保证。
