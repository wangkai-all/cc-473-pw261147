# 模式注册表与兼容性检查

零依赖的 Node.js 模式注册表（Schema Registry）。支持生产者与消费者**分别**声明
向后（BACKWARD）、向前（FORWARD）、全兼容（FULL）或不限制（NONE）策略；
发布新版本时执行三道闸门；用兼容窗口治理旧版生产者；回滚时保留已写入的新字段；
全部状态以事件溯源方式持久化，崩溃后可恢复。

## 快速开始

```bash
node scripts/seed-demo.js   # 写入演示数据（多版本、多参与者、回滚场景）
npm start                   # 启动服务，默认 http://localhost:3000
npm test                    # 运行全部测试（47 个用例，零外部依赖）
```

打开 `http://localhost:3000` 即可看到控制台页面：版本时间线、三向兼容结果徽章、
生产者/消费者表格、兼容窗口倒计时、存量数据与事件审计。

环境变量：`PORT`（默认 3000）、`SCHEMA_REGISTRY_DATA`（默认 `./data`）。

## 核心概念

### 兼容方向

以模式演进 `oldSchema → newSchema` 为基准：

| 策略 | 含义 | 典型破坏项 |
| --- | --- | --- |
| BACKWARD 向后 | 老读取方能读新数据 | 新增必填且无默认值字段、新增枚举值、字段变可选 |
| FORWARD 向前 | 新读取方能读旧数据 | 删除必填字段、新增必填字段、字段变必填、删除枚举值 |
| FULL 全兼容 | 两个方向都通过 | 上述任意一项 |
| NONE | 不做限制 | — |

仅允许 `int→long`、`float→double` 的数值拓宽作为安全的类型变更。

每个**生产者/消费者独立选择策略**。发布时按每个活跃参与者注册的模式版本与其
声明的策略分别判定，任一活跃消费者不兼容即阻断发布。

### 发布三闸门

`POST /api/subjects/:name/versions` 依次执行：

1. **存量数据闸门** —— 理论上的 FORWARD 破坏会与真实历史记录逐条比对，
   只有确实命中至少一条记录才算阻断项；命中则必须提供迁移计划。
2. **迁移计划闸门** —— 计划中的 `key`（如 `FIELD_ADDED_REQUIRED:tenant`）
   必须覆盖全部数据影响项，否则返回 `MIGRATION_PLAN_INCOMPLETE`。
3. **活跃消费者闸门** —— 每个活跃消费者按自身策略判定，
   不兼容时返回 `COMPATIBILITY_VIOLATION` 并附带责任消费者明细。

活跃生产者不阻断发布，而是通过下面的兼容窗口治理。

### 兼容窗口与旧生产者阻断

每次发布都带一个兼容窗口（默认 7 天）。生产者写入
（`POST .../produce`）时：

- 仍停留在旧版本 **且** 最新版本窗口未到期 → 允许写入；
- 窗口到期且落后于最新版本 → 返回 `409 OLD_PRODUCER_BLOCKED`；
- 已升级到最新版本的生产者不受窗口影响。

窗口可通过 `.../windows/:version/extend` 延长。

### 回滚不丢新字段

`POST .../rollback` 回到历史版本时，当前版本相对目标版本**新增的字段会被保留为
可选透传字段**（沿用原默认值），因此：

- 已写入这些字段的历史记录原样保留，不丢数据；
- 老生产者可以只写基础字段继续工作。

若已登记**不可逆迁移**（`irreversible: true`），回滚返回
`409 IRREVERSIBLE_MIGRATION`。回滚是显式运维动作，会绕过常规闸门但仍生成
完整的三向兼容检查结果用于展示。

## 持久化与失败恢复

- 所有状态变更先以 `fsync` 追加到 `data/wal.log`，再应用到内存状态；
- 周期性通过「临时文件 + rename」原子写入 `data/snapshot.json` 并压缩 WAL；
- 启动时加载快照并重放其后的 WAL 事件；
- WAL 末尾的半写行（崩溃于写入中途）会被识别、跳过并截断，已确认事件不丢。

并发发布由按主题分片的异步互斥锁（`src/lock.js`）串行化，保证版本号连续、
失败请求不占用版本号。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/subjects` | 创建主题（带默认策略） |
| GET | `/api/subjects` / `/api/subjects/:name` | 列表 / 详情视图模型 |
| POST | `/api/subjects/:name/versions` | 发布新版本（三闸门） |
| GET | `/api/subjects/:name/versions/:v` | 查询单个版本 |
| POST | `/api/subjects/:name/actors` | 注册生产者/消费者（含独立策略） |
| DELETE | `/api/subjects/:name/actors/:actor` | 注销参与者 |
| POST | `/api/subjects/:name/actors/:actor/heartbeat` | 心跳 |
| POST | `/api/subjects/:name/produce` | 生产者写入（窗口 + 模式校验） |
| POST | `/api/subjects/:name/ingest` | 运维直接写入 |
| GET | `/api/subjects/:name/records` | 存量记录 |
| POST | `/api/subjects/:name/migrations` | 登记迁移执行（可标记不可逆） |
| POST | `/api/subjects/:name/windows/:v/extend` | 延长兼容窗口 |
| POST | `/api/subjects/:name/rollback` | 回滚（保留新字段） |

错误统一返回 `{ error, message, details }`，状态码由领域错误码映射
（404 资源缺失、409 冲突/阻断/不可逆、422 校验或兼容问题）。

## 代码结构

```
src/
  schema.js        模式规范化、字段/记录校验、指纹
  compatibility.js 字段级 diff + BACKWARD/FORWARD/FULL 判定 + 存量数据影响分析
  registry.js      事件溯源注册表：发布闸门、窗口、迁移、回滚、页面视图模型
  store.js         WAL + 原子快照的事件存储与崩溃恢复
  lock.js          互斥锁 / 按主题分片锁
  clock.js         系统时钟与测试用可控时钟
  errors.js        领域错误码与 HTTP 状态映射
  server.js        零依赖 HTTP 路由与静态页面
web/               控制台页面（原生 HTML/CSS/JS，明暗双主题）
test/              兼容引擎、注册表、HTTP 端到端测试
scripts/seed-demo.js 演示数据
```
