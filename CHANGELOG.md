# 变更日志

## v1.2.0 (2026-06-26) — 安全加固与深度修复

### 🔴 安全漏洞修复（P0）
- **JWT 密钥不安全后备值**：未设置 AUTH_SECRET 时服务拒绝启动
- **CORS 全开放**：改为通过 CORS_ORIGIN 环境变量配置
- **VPS IP 硬编码**：deploy.sh 改为 $VPS_HOST 环境变量
- **飞书 Webhook 硬编码**：改为 $FEISHU_WEBHOOK_URL（⚠️ 需飞书后台撤销旧Token）
- **管理员密码硬编码**：改为后端二次鉴权
- **CI/CD 从未工作**：deploy.yml 转义错误修复

### 🟠 高风险修复（P1）
- AUTH_SECRET 弱密钥 → 64位真随机
- Docker root → node 用户
- Redis 无密码 → requirepass
- 容器名不匹配 mywebsite→xiangtai
- 登录限流：10次/分/IP，注册 5次/时/IP
- AI companyId 绕过强制修复
- cloudflared 二进制从 Git 删除（53MB）

### 🟡 中风险修复（P2）
- render.yaml 补充环境变量
- 请求体 20MB 限制
- 公共追踪接口限流
- 密码 ≥6→≥8位
- 手机号/邮箱格式校验
- setup-cron 追加模式
- 安全响应头（CSP/X-Frame-Options 等）
- Docker 健康检查
- env.example 补充 5 个变量
- `generatePrealertNo` 事务锁修复
- 预报单删除级联清理
- clientId 跨公司校验
- 汇率超时 + 环境变量覆盖
- 图片路径遍历防御
- AI 输出 HTML 清洗
- 图片删除 DB 先于磁盘

### 🔵 清理与统一
- 删除 6 个文件：sqlite.ts、ai-sqlite-store.ts、ai-session-memory-store.ts、REASONIX.md、codex-review-evo-guide.md、cloudflared
- 前后端运单状态体系统一（STATUS_FLOW 新增 "created"）
- Shared-types StatusAuditLog → StatusLog 修复
- 3 个部署文档 SQLite→PostgreSQL
- CONTEXT_HANDOFF.md 全面刷新
- `mock-session.ts` → `auth-session.ts` 重命名（10文件）
- `MockRole/MockSession` → `AuthRole/AuthSession`
- 重复函数 `resetUserPassword` 合并为 `setAdminStaffPassword`
- 未用函数删除：saveAdminShippingRate、deleteAdminShippingRate
- sealLoadingManifest 返回类型修复
- 菜单配置补充 3 个缺失入口
- 8 个 catch{} → console.error
- 3 个轮询添加 document.hidden 检查
- Promise.all → Promise.allSettled（客户端数据刷新）
- loading/error/not-found 全局 Next.js 页面
- AiChatWidget：AbortController + 打字性能优化 + 按钮颜色修复
- RoleShell 定时器移除 + from 参数保留
- .gitignore 优化（tools/、*.tsbuildinfo）

### 📊 统计
- 发现问题：83 项
- 已修复：78 项
- 修改文件：51 个
- 新增文件：5 个
- 删除文件：6 个
- 净删代码：-1,445 行
- **JWT 密钥不安全后备值**：未设置 `AUTH_SECRET` 时服务拒绝启动，不再使用硬编码后备值
- **CORS 全开放**：`Access-Control-Allow-Origin` 改为通过 `CORS_ORIGIN` 环境变量配置
- **VPS IP 硬编码**：`deploy.sh` 改为 `$VPS_HOST` 环境变量
- **飞书 Webhook 硬编码**：`monitor.sh`、`backup-db.sh` 改为 `$FEISHU_WEBHOOK_URL`
- **管理员密码硬编码 `lyj200538`**：改为后端二次密码鉴权（`verifyPassword`）

### 🟠 高风险修复（P1）
- **AUTH_SECRET 弱密钥**：生成真随机 64 位 Base64 密钥
- **Docker root 运行**：添加 `USER node` + `--chown=node:node`
- **Redis 无密码**：添加 `requirepass` 认证
- **监控容器名不匹配**：`mywebsite-*` → `xiangtai-*`
- **登录限流**：新增 `rate-limit.ts`，登录 10次/分/IP，注册 5次/时/IP
- **AI 路由 companyId 绕过**：强制使用 `auth.companyId`，禁止跨公司查询

### 🟡 中风险修复（P2）
- `render.yaml` 补充 `DATABASE_URL`、`REDIS_URL`
- 请求体添加 20MB 大小限制
- 公共追踪接口添加速率限制（30次/分/IP）
- `.gitignore` 添加 `*.tsbuildinfo`、`tools/cloudflared`
- 移除无用依赖 `ssh2`
- 密码策略升级：≥6位 → ≥8位
- 注册页添加手机号/邮箱格式校验
- `setup-cron.sh` 改为追加模式，不覆盖已有 crontab
- 前端安全响应头（X-Frame-Options 等）
- Docker Web/API 容器添加健康检查
- `env.example` 补充 5 个缺失环境变量

### 🔵 清理与统一
- 删除 3 个遗留 SQLite 文件：`db/sqlite.ts`、`ai-sqlite-store.ts`、`ai-session-memory-store.ts`（1,581 行死代码）
- 统一前后端运单状态体系：`STATUS_FLOW` 新增 `"created"` 首状态
- 更新 `CONTEXT_HANDOFF.md`：SQLite → PostgreSQL 描述
- `cloudflared` 二进制文件从 Git 追踪中移除

## v1.1.0 (2026-05-28)

### 🐛 严重 Bug 修复

#### S1. 账号管理页面无数据
- **问题**: `GET /admin/users` 未传 `?role=` 参数时返回空数组，管理员页面永远显示"暂无账号"
- **修复**: 无 role 参数时返回所有 staff + client 用户

#### S2. 创建账号角色固定为员工
- **问题**: `POST /admin/users` 后端硬编码 `role: "staff"`，前端选"客户"实际创建员工
- **修复**: 后端读取 `body.role` 字段，按需创建 staff 或 client

#### S3. 装柜管理前后端路径不匹配
- **问题**: 后端使用 `:id` 路径参数但 HTTP 服务器仅支持精确路径匹配，前端路径名也与后端不一致
- **修复**: 统一改用 query param 传 ID，后端路由改为 `detail`/`seal`/`add-shipment`

#### S4. 修改密码/封禁 API 不可用
- **问题**: `resetUserPassword` 调用路径 `/:id/reset-password` 后端不存在；`toggleUserBan` 路由未注册
- **修复**: 前端改调用已存在的 `/admin/users/set-password`；新增 `/admin/users/toggle-ban` 后端路由

### 🆕 新功能

#### 客户端确认发货完整链路
- 新增 `POST /client/prealerts/ship` 端点
- 客户端已审核预报单支持查询（`GET /client/prealerts?status=approved`）
- 确认发货后自动生成正式运单号（格式: 仓库前缀 + 日期 + 3位流水）
- 端到端流程: 创建报单 → 审核 → 确认发货 → 运单追踪

### 🔧 代码质量

- 修复 9 个文件中的 Unicode 智能引号问题（44 处替换）
- 修复前端 4 个 TypeScript 类型错误 (`ManagedUser`、`FinanceSummary`、`LoadingManifestItem`、`LoadingManifestDetail`)
- 补齐 `fetchLoadingManifests` 函数签名支持过滤参数
- 后端 `ai-service.ts` 中 3 处引号边界问题修复

### 📝 文档

- 更新 README.md 核心接口列表（含完整 API 清单）
- 新增 CHANGELOG.md
