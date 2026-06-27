# 在 Hostinger 上部署本仓库（VPS）

本系统需要 **两台长期运行的进程**：

- Next.js 前端（`apps/web`，默认监听 `3000`）
- Node API（`apps/api`，默认监听 `3001`）

浏览器里的请求通过环境变量 **`NEXT_PUBLIC_API_BASE_URL`** 指向公网可访问的后端 URL，因此不能使用「仅 PHP/静态托管、不能跑常驻 Node」的典型共享主机方案，建议使用 **Hostinger VPS（或其它带 SSH 的云主机）**。

---

## 1. 准备

| 项目 | 说明 |
|------|------|
| 主机 | 至少 2 vCPU / 2GB RAM 的 VPS 更稳妥 |
| Node.js | **22+**（API 使用 Prisma + PostgreSQL） |
| 域名 | 可拆成：`www` 指向前端，`api.` 指向 API（或同一域名路径反代） |

在服务器的仓库根目录下运行 API：需要配置 `DATABASE_URL` 指向 PostgreSQL 实例。示例：

```bash
export DATABASE_URL="postgresql://user:password@localhost:5432/xiangtai"
```

务必定期备份该文件（及同目录 WAL/SHM 若存在）。

---

## 2. 首次部署步骤（Ubuntu 示意）

假设代码放在 `/var/www/MyWebSite`，前端域名 `yourdomain.com`，API 域名 `api.yourdomain.com`。

### 2.1 安装 Node.js 与 PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential
sudo npm install -g pm2
```

（亦可用 nvm，只要保证 `node -v` ≥ 20。）

### 2.2 拉取代码与安装前端依赖

```bash
cd /var/www
sudo git clone <你的仓库 URL> MyWebSite
cd MyWebSite/apps/web
npm ci
```

### 2.3 前端环境变量与构建

`NEXT_PUBLIC_*` 会在 **构建时** 写入产物，须在 `npm run build` 前设定：

```bash
export NEXT_PUBLIC_API_BASE_URL="https://api.yourdomain.com"
npm run build
```

### 2.4 API 环境变量

在仓库根目录（与 README 一致）启动 API，例如创建 `/var/www/MyWebSite/.env` 或写在 shell/PM2 里：

```bash
export PORT=3001
export AUTH_SECRET="<至少32位随机串>"
export DEEPSEEK_API_KEY="sk-..."
export DEEPSEEK_MODEL="deepseek-chat"
export DEEPSEEK_API_BASE_URL="https://api.deepseek.com/chat/completions"
export DATABASE_URL="postgresql://user:password@localhost:5432/xiangtai"
```

若使用 `.env`，需确保 API 进程在启动时已加载（当前项目若未统一用 `dotenv`，请以 `source` 或 PM2 `env_file` 等方式注入变量）。

### 2.5 用 PM2 常驻运行

在 **仓库根目录**：

```bash
cd /var/www/MyWebSite
pm2 start "npx tsx apps/api/src/main.ts" --name logistics-api
```

在 **`apps/web` 目录**：

```bash
cd /var/www/MyWebSite/apps/web
pm2 start npm --name logistics-web -- start
pm2 save
pm2 startup
```

（`pm2 startup` 按提示执行，保证重启后自启。）

---

## 3. Nginx 反向代理与 HTTPS

安装 Nginx 与证书（Let's Encrypt 等）后，示例配置思路：

- `yourdomain.com` → `http://127.0.0.1:3000`
- `api.yourdomain.com` → `http://127.0.0.1:3001`

注意把 `client_max_body_size` 调到业务需要的大小；开启 `proxy_http_version 1.1` 与合适的前向头（`Host`、`X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto`），便于后续若要做限流或日志。

Hostinger 面板若提供「SSL / 域名绑定」，把 A 记录指到 VPS 公网 IP 即可。

---

## 4. 防火墙

仅开放 `22`（SSH）、`80`、`443`；**不要**把 `3000`、`3001` 直接暴露到公网，由 Nginx 反代即可。

---

## 5. 更新发布流程

```bash
cd /var/www/MyWebSite
git pull
cd apps/web
export NEXT_PUBLIC_API_BASE_URL="https://api.yourdomain.com"
npm ci
npm run build
pm2 restart logistics-web
# API 若仅逻辑变更且未改依赖，一般：
cd /var/www/MyWebSite
pm2 restart logistics-api
```

若改了 `NEXT_PUBLIC_*`，必须重新 `npm run build`。

---

## 6. 常见问题

1. **前端报连不上接口**  
   检查浏览器里请求的 base URL；检查 Nginx 是否把 `api` 域名指到 `3001`；检查 CORS（当前 API 较宽松，多为 URL 写错或未 HTTPS）。

2. **数据库丢失**  
   确认 `DATABASE_URL` 指向持久数据库；勿在每次部署时删除数据库。

3. **`npx tsx` 慢或失败**  
   可固定安装：`npm install -g tsx`，PM2 里改为 `tsx apps/api/src/main.ts`；或后续增加 `apps/api` 的 `package.json` 与 `npm run start` 脚本以锁定版本。

---

## 7. Hostinger 产品对照

- **VPS / Cloud**：适合本方案（SSH + 自建 Nginx + PM2）。  
- **仅 Web Hosting（无 Node 常驻）**：不适合跑本仓库的 API；除非改为完全无后端的架构（与本项目现状不符）。

若你希望把「同域 `/api` 反代」写进 Next 配置以减少跨子域问题，可在后续迭代里为 `apps/web/next.config.ts` 增加 `rewrites`；当前按子域配置即可工作。
