# Render 部署指南（前后端分离）

本项目在 Render 建议创建 2 个 Web Service：

- `xiangtai-api`：后端 API（Node + PostgreSQL）
- `xiangtai-web`：前端 Next.js

仓库根目录已提供 `render.yaml`，可直接走 Blueprint 一键创建。

## 1. 准备

1. 代码已推送到 GitHub。
2. 登录 Render，点击 **New +** -> **Blueprint**。
3. 选择本仓库，Render 会识别根目录 `render.yaml`。

## 2. 首次创建时需填写的关键变量

### 2.1 后端服务 `xiangtai-api`

- `AUTH_SECRET`：必填，至少 32 位随机字符串。
- `DEEPSEEK_API_KEY`：可选，不填则 AI 能力不可用。

`DATABASE_URL 通过环境变量配置

### 2.2 前端服务 `xiangtai-web`

- `NEXT_PUBLIC_API_BASE_URL`：必填，值为后端公网地址，例如：
  - `https://xiangtai-api.onrender.com`

## 3. 部署顺序与注意事项

1. 先创建并确认 `xiangtai-api` 变为 **Live**。
2. 将 `xiangtai-api` 的 URL 填入 `xiangtai-web` 的 `NEXT_PUBLIC_API_BASE_URL`。
3. 手动触发 `xiangtai-web` 的 **Redeploy**（前端需要重新构建才能注入新变量）。

## 4. 验证

1. 打开前端 URL，进入登录页。
2. 在浏览器网络请求中确认接口请求发往 `NEXT_PUBLIC_API_BASE_URL` 指向的地址。
3. 若登录失败，优先检查：
   - 前端变量是否写成了错误地址（如 `localhost`）。
   - API 服务是否启动成功。
   - `AUTH_SECRET` 是否缺失。

## 5. 数据持久化说明

- API 使用 PostgreSQL，数据文件位于 `PostgreSQL 数据库`。
- `render.yaml` 已配置持久盘，重启服务不会丢失数据库。
