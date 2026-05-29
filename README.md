# 湘泰国际物流系统（V1）

单仓库、单前端应用（RBAC），包含三个角色界面：

- `admin`（管理员）
- `staff`（员工）
- `client`（客户端）

并已接入 DeepSeek AI 对话能力（客户端提问订单进度/发货汇总）。

## 核心业务流程图

```
客户创建预报单 → 员工审核 → 客户确认发货 → 生成正式运单号 → 物流追踪
     (pending)      (approved)     (shipped)      (trackingNo)
```

## 修复记录

详见 [CHANGELOG.md](CHANGELOG.md)。

## 目录结构

- `apps/web`：前端（Next.js）
- `apps/api`：后端（最小 HTTP 服务）
- `packages/shared-types`：共享类型
- `docs`：业务与协作文档

## 运行要求

- **Node.js 22+**（后端使用 `node:sqlite`）
- npm

## 一键安装依赖（推荐）

在**仓库根目录**执行：

```bash
npm install
```

会安装根目录的 `tsx`，并自动执行 `apps/web` 下的 `npm install`（`postinstall`）。

## 启动方式

### 1) 启动后端（端口 3001）

在仓库根目录，PowerShell 示例：

```powershell
$env:AUTH_SECRET="请替换为至少32位随机密钥"
$env:DEEPSEEK_API_KEY="sk-你的真实key"
$env:DEEPSEEK_MODEL="deepseek-chat"
$env:DEEPSEEK_API_BASE_URL="https://api.deepseek.com/chat/completions"
npm run dev:api
```

### 2) 启动前端（端口 3000）

再开一个终端，在仓库根目录：

```bash
npm run dev:web
```

访问：`http://127.0.0.1:3000/`

### 3) 让同一局域网内其他人打开（临时）

**推荐（自动填本机 IP）**：在一个终端先启动 API（`npm run dev:api`），另一个终端在仓库根目录执行：

```bash
npm run dev:web:lan
```

**手动**：查本机局域网 IP（例如 `192.168.1.100`），设置前端能访问的 API 地址，并监听所有网卡：

```powershell
$env:NEXT_PUBLIC_API_BASE_URL="http://192.168.1.100:3001"
npm run dev:web:public
```

他人用浏览器打开：`http://你的局域网IP:3000`（防火墙需放行 3000、3001）。

**公网任意人访问**请用云服务器或 Docker，见 [docs/deploy-china.md](docs/deploy-china.md)。

## 登录与鉴权

页面入口：

- `GET /login`：登录页
- `GET /register`：客户端注册页

登录成功后，前端会自动在请求头附带：

- `Authorization: Bearer <token>`

后端已改为严格鉴权：缺少或无效 token 会返回 `401 UNAUTHORIZED`。

## AI 功能

客户端：

- AI 客服按钮（对话）
- 常用问题建议

管理员：

- 状态中文映射管理（保存/恢复默认）
- AI 知识投喂（新增）
- AI 知识删除
- AI 审计日志查询（接口）

## 核心接口（V1）

### 客户端
- `POST /client/prealerts` — 创建预报单
- `GET /client/prealerts?status=pending|approved|shipped` — 查询预报单
- `POST /client/prealerts/ship` — 确认发货（生成正式运单号）
- `GET /client/orders` — 正式订单列表（含物流轨迹）
- `GET /client/shipments/track?trackingNo=xxx` — 运单追踪
- `POST /client/ai/chat` — AI 客服对话
- `GET /client/ai/suggestions` — AI 常用建议

### 员工端
- `GET /staff/prealerts` — 待审核预报单列表
- `POST /staff/prealerts/approve` — 审核通过预报单（自动创建 Shipment）
- `POST /staff/orders` — 创建正式订单
- `POST /staff/orders/patch-shipment-bundle` — 更新运单信息
- `POST /staff/shipments/update-status` — 推进运单状态
- `GET /staff/loading-manifests` — 装柜列表
- `POST /staff/loading-manifests` — 创建装柜
- `GET /staff/loading-manifests/detail?id=xxx` — 装柜详情
- `POST /staff/loading-manifests/seal?id=xxx` — 封柜
- `POST /staff/loading-manifests/add-shipment?id=xxx` — 添加运单到柜
- `POST /staff/orders/product-images` — 上传产品图片

### 管理员
- `GET /admin/dashboard/overview` — 运营看板
- `GET /admin/users` — 用户列表（?role=staff|client 筛选）
- `POST /admin/users` — 创建用户（支持 role=staff|client）
- `POST /admin/users/set-password` — 修改密码
- `POST /admin/users/toggle-ban` — 禁用/启用用户
- `GET /admin/orders` — 订单管理
- `POST /admin/orders/update` — 更新订单
- `GET /admin/containers` — 柜列表
- `POST /admin/containers` — 新建柜子
- `POST /admin/containers/status` — 变更柜子状态
- `POST /admin/containers/load` — 装柜
- `DELETE /admin/containers/load?id=xxx` — 卸柜
- `GET /admin/finance/summary` — 财务汇总
- `GET /admin/lmp/rates` — 运价管理
- `GET /admin/customs/cases` — 清关案件
- `GET /admin/lastmile/orders` — 尾程派送
- `POST /admin/ai/knowledge` — AI 知识投喂
- `DELETE /admin/ai/knowledge?id=kn_xxx` — 删除知识
- `GET /admin/ai/audit-logs` — AI 审计日志

## 常见问题

### 1) 3001 端口被占用

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN | awk 'NR>1 {print $2}' | xargs -r kill -9
```

### 2) AI 返回"未配置 API Key"

说明后端未读到 `DEEPSEEK_API_KEY`。请在项目根目录建 `.env` 并写 `DEEPSEEK_API_KEY=sk-xxx`，或在同一终端 `export DEEPSEEK_API_KEY="sk-xxx"` 后再启动后端。详见 [docs/deepseek-setup.md](docs/deepseek-setup.md)。

### 3) AI 返回 402

说明 DeepSeek 账户额度或计费配置问题，不是本地代码链路问题。

## 生产部署（Docker，含面向国内用户说明）

仓库根目录已提供 `Dockerfile.api`、`Dockerfile.web`、`docker-compose.yml`。复制 `env.example` 为 `.env` 并填写 `AUTH_SECRET`、`NEXT_PUBLIC_API_BASE_URL` 后执行 `docker compose up -d --build`。

**详细步骤（云服务器、域名、备案与 HTTPS）见 [docs/deploy-china.md](docs/deploy-china.md)。**

## Render 部署（前后端分离）

仓库根目录已提供 `render.yaml`，可在 Render 通过 Blueprint 一键创建 `xiangtai-api` 与 `xiangtai-web` 两个服务。

关键变量：

- API：`AUTH_SECRET`（必填），`DEEPSEEK_API_KEY`（可选）
- Web：`NEXT_PUBLIC_API_BASE_URL`（填 API 的公网 URL，例如 `https://xiangtai-api.onrender.com`）

详细步骤见 [docs/deploy-render.md](docs/deploy-render.md)。
