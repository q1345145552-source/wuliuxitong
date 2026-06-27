# 阶段移交说明（CONTEXT_HANDOFF）

> 本文档用于记录**当前阶段开发进度**、**未解决问题**与**下一阶段计划**。  
> 更新日期：**2026-06-26**（已迁移至 PostgreSQL，清理遗留 SQLite 代码）

---

## 一、当前阶段已完成内容（开发进度概要）

### 1. 架构与技术栈

- **前端**：Next.js 16（`apps/web`），多端角色界面（管理员 / 员工 / 客户）。
- **后端**：自建最小 HTTP 服务（`apps/api`），Prisma ORM + PostgreSQL 数据库。
- **共享类型**：`packages/shared-types`（部分类型需与 Prisma 表同步更新）。
- **AI**：DeepSeek API（`deepseek-client.ts`），Prisma 存储后端。
- **文档**：业务与接入说明主要在 `README.md`、`docs/` 下若干文档。

### 2. 业务与 RBAC

- 客户：预报单、订单查询、物流相关视图、账单相关页面（如 `apps/web/src/app/client/bills/`）等。
- 员工：运单列表与筛选 / 导出 Excel、批量状态流转、预报审核与建单等业务能力（`apps/web/src/app/staff/page.tsx` 等）。
- 管理员工作台（`apps/web/src/app/admin/page.tsx`）按板块组织，主要包括：
  - **运营看板**：核心 KPI（员工数、客户数、今日订单、在途统计、收货方数等）。
  - **员工管理**：列表、**添加员工 / 删除 / 设置密码**（后端：`apps/api/src/modules/admin/routes.ts`，用户表扩展 `password_hash` 等）；**折叠**，降低误删风险。
  - **客户管理**：列表，**新建客户**（客户名、公司名、电话、邮箱等；后端用户表扩展 `company_name`、`email`；创建接口含列缺失自愈逻辑）。
  - **订单数据管理**：全量订单表格、**导出 Excel**、**折叠**。
  - **AI 知识投喂**与**已投喂知识列表**：管理端 CRUD。
- **鉴权演进**： README 写明登录后以 `Authorization: Bearer <token>` 调用 API；仍存在与历史 Mock 会话并行的过渡期行为时，需在代码中逐项核对一致性（见下文「未解决问题」）。

### 3. 后端 API（管理端相关示例）

- `GET /admin/dashboard/overview` — 看板聚合指标  
- `GET|POST .../admin/users`、`DELETE /admin/users?id=`、`POST /admin/users/set-password` — 员工  
- `POST /admin/users/client` — 创建客户  
- `GET /admin/orders` — 管理员订单列表  
- `GET|POST|DELETE /admin/ai/knowledge` — 知识库管理  
- 其余订单、运单、`/auth`、`/client/ai/chat` 等见 `README.md` 核心接口章节与 `apps/api/src/main.ts` 控制台输出。

### 4. AI 与 DeepSeek

- **链路**：管理员投喂知识 → 存储 → 客户在 `POST /client/ai/chat` 时使用 `ClientAiService` 拉取公司范围内订单/运单与知识条目，拼装上下文后调用 **DeepSeek**（`HttpDeepSeekClient`）生成/润色回答。
- **数据**：AI 相关数据已通过 **SQLite** 侧的存储抽象接入（参见 `apps/api/src/modules/ai/` 下的 `Sqlite*` 与 `registerClientAiRoutes(app, db.db)`），运单与订单查询走真实库表而非纯内存 Seed（以当前代码为准）。
- **配置**：需配置 **`DEEPSEEK_API_KEY`**（及可选模型、BASE_URL）；`README.md` 建议项目根 `.env`。若文档 `docs/deepseek-setup.md` 与仓库不一致，应补齐或改写 README 链接。
- **无 Key / 调用失败**：`ai-service.ts` / `deepseek-client.ts` 中应有降级路径（占位符或未配置提示 + 业务结论），避免直接向用户吐出整段内部 JSON。

### 5. 数据与兼容

- **PostgreSQL**：生产使用 Neon 云数据库；本地开发可用 Docker Compose 中 Postgres 容器。
- 密码使用 Node.js `scrypt` 哈希（`crypto-utils.ts`），已升级到安全级别。
- 图片存储：同时支持 Base64（数据库）和文件系统（`IMAGES_DIR`），建议生产迁移到对象存储。
- **遗留 SQLite 代码已清理**（`db/sqlite.ts`、`ai-sqlite-store.ts` 等 3 个文件已删除）。

---

## 二、未解决问题 / 已知风险（技术债与缺口）

### 1. 环境与密钥

| 事项 | 说明 |
|------|------|
| `AUTH_SECRET` | 2026-06-26 已更换为随机密钥；未配置时服务拒绝启动（`token.ts` 会抛错）|
| `CORS_ORIGIN` | 生产环境需设置具体域名（`server.ts` 通过环境变量控制）|
| `FEISHU_WEBHOOK_URL` | 飞书通知需配置此变量；旧 Token 已暴露于 Git 历史，必须撤销重新生成 |

### 2. 安全与合规（2026-06-26 已加固）

- ✅ 密码使用 Node.js `scrypt` 哈希（`crypto-utils.ts`）
- ✅ 登录/注册限流：登录 10次/分/IP，注册 5次/时/IP（`rate-limit.ts`）
- ✅ 管理员删除用户需二次密码鉴权（`verifyPassword`）
- ✅ Docker 容器以 `node` 用户运行（非 root）
- ✅ `.env` 已从 Git 排除，包含生产凭据注释提醒
- ✅ AI 输出经 HTML 清洗（`sanitize()` 函数去除 `<script>`、`onerror` 等）
- ✅ 全局安全响应头（CSP、X-Frame-Options、X-Content-Type-Options 等）
- ⚠️ 飞书 Webhook 旧 Token 仍需手动撤销（飞书后台操作）

### 3. 产品一致性与运维

- ✅ `mock-session.ts` → `auth-session.ts` 已重命名（2026-06-26）
- ⚠️ Excel 导出依赖浏览器 **`xlsx`** 包与大列表性能未做分页与限流评估。
- ⚠️ 缺少自动化测试覆盖（单元 / 集成 / E2E）。

### 4. 数据结构与一致性（2026-06-26 已处理）

- ✅ SQLite → PostgreSQL 全面迁移完成
- ✅ 遗留 SQLite 文件已删除（3 文件，1,581 行）
- ✅ 前后端运单状态体系统一（`STATUS_FLOW` 添加 `"created"`首状态）
- ✅ `generatePrealertNo` 事务锁修复（`$transaction` 包裹）
- ✅ 预报单删除支持级联清理（products + shipments）
- ✅ `clientId` 跨公司校验（`POST /staff/orders`）
- ✅ 图片路径遍历防御（`orderId` 过滤特殊字符）

---

## 三、下一步计划（建议优先级）

### P0 — 环境与上线基础 ✅ 已完成

1. ~~统一环境与密钥~~
2. ~~核实鉴权链路~~ — 全站仅 JWT + `Authorization: Bearer`

### P1 — 安全与可靠性 ✅ 已完成

3. ~~密码哈希升级~~ — 已使用 `scrypt`
4. ~~管理员敏感操作~~ — 已实现后端二次密码鉴权

### P2 — 产品与体验

5. **前端巨型组件拆分**：`staff/page.tsx`(3578行)、`admin/page.tsx`(2436行)、`client/page.tsx`(1682行)
6. **报表与订单**：大额导出可走服务端生成下载链接或使用流式，避免单次拉全表。
7. **监控与告警**：DeepSeek 失败率、超时、402/401 等指标。

### P3 — 工程化

8. **CI**：lint、typecheck、自动化测试脚本。
9. **结构化日志**：替换 `console.log` 为 `pino`/`winston`。
10. **里程碑文档**：在每个大版本末尾更新 `CONTEXT_HANDOFF.md` 的日期与三节内容。

---

## 四、如何接手本仓库（快速起手）

```bash
# 后端（需配置环境变量与 DeepSeek）
npx tsx apps/api/src/main.ts

# 前端
cd apps/web && npm install && npm run dev
```

详细环境与 AI 参见根目录 **`README.md`**；若存在 **`docs/deepseek-setup.md`**，以该文件为准做 DeepSeek 对接。

---

*本移交文档由阶段性总结生成；若与源码不一致，以 Git 与本仓库 **`README.md`** 为准并及时修订本节。*
