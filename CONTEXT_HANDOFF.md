# 阶段移交说明（CONTEXT_HANDOFF）

> 本文档用于记录**当前阶段开发进度**、**未解决问题**与**下一阶段计划**。  
> 更新日期：**2026-05-12**（以仓库当前状态为依据；后续迭代请按需修订本文件。）

---

## 一、当前阶段已完成内容（开发进度概要）

### 1. 架构与技术栈

- **前端**：Next.js（`apps/web`），多端角色界面（管理员 / 员工 / 客户）。
- **后端**：自建最小 HTTP 服务（`apps/api`），Node `node:sqlite` 等业务数据读写。
- **共享类型**：`packages/shared-types`。
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

- **SQLite**：`apps/api/data/dev.sqlite`（或 `SQLITE_PATH` 指定路径）；迁移包含 `password_hash`、`company_name`、`email` 等与用户扩展字段。
- 员工密码当前为 **SHA-256**，仅适用于演示；生产应换 **bcrypt/argon2** 等。

---

## 二、未解决问题 / 已知风险（技术债与缺口）

### 1. 环境与密钥

| 事项 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | 本地/部署环境若未加载，客户端 AI 将走降级文案；需约定统一方式：`export` / 项目根 `.env` / `node --env-file` 等。**若曾计划 `load-dotenv.ts` 自动读 `.env`，需确认是否已并入 `main.ts`。 |
| `AUTH_SECRET`（若启用 JWT） | `README.md` 要求服务端配置随机密钥；需与 Cookie/Token 实际实现对照，避免生产默认弱配置。 |

### 2. 安全与合规

- 员工密码哈希方案偏简单；需策略：盐、迭代、禁止日志打印密钥。
- 管理端批量删除员工、SQLite 备份与审计：生产需操作审计与安全策略评估。

### 3. 产品一致性与运维

- 前端若仍混杂 **Mock Session**（`apps/web/src/auth/mock-session.ts`）与 **Bearer Token**，需统一为一种模式并更新文档。
- Excel 导出依赖浏览器 **`xlsx`** 包与大列表性能未做分页与限流评估。
- 缺少自动化测试覆盖（单元 / 集成 / E2E）。

### 4. 文档与仓库同步

- `README.md` 引用 `docs/deepseek-setup.md` 时若文件缺失，新来的开发者会感到困惑——应补文件或删掉链接。
- 「湘泰」「中泰」等系统在 README / 产品与代码注释中的称谓需对齐品牌。

---

## 三、下一步计划（建议优先级）

### P0 — 环境与上线基础

1. **统一环境与密钥**：项目根 `.env.example`（含 `DEEPSEEK_API_KEY`、`AUTH_SECRET`、`PORT`、`NEXT_PUBLIC_API_BASE_URL`、`SQLITE_PATH`）+ 后端启动必读 `.env` 或文档化 `node --env-file=.env`。  
2. **核实鉴权链路**：全站仅用 JWT + `Authorization`，或保留开发用 Mock —— 写入 `README` 与环境区分（dev/staging/prod）。

### P1 — 安全与可靠性

3. **密码哈希升级**：新员工/重置密码改用 bcrypt（或等价方案），旧数据按需迁移策略。  
4. **管理员敏感操作**：删除员工二次确认已实现于前端；可考虑后端幂等与软删除。

### P2 — 产品与体验

5. **知识库**：已落 SQLite；可补充分页、搜索与「知识条目版本」运维能力。  
6. **报表与订单**：大额导出可走服务端生成下载链接或使用流式，避免单次拉全表。  
7. **监控与告警**：DeepSeek 失败率、超时、402/401 等指标。

### P3 — 工程化

8. **根级 `package.json` + workspaces**（可选）：统一 `npm run dev:api` / `npm run dev:web`。  
9. **CI**：lint、typecheck、`sqlite` migration 自检脚本。  
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
