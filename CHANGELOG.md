# 变更日志

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
