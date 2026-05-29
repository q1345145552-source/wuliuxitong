# 国内客户可访问：部署说明

我无法代替你在云厂商控制台「点部署」，但按下面做即可让中国大陆用户通过公网访问（需你自备服务器与域名）。

## 架构说明

- **前端**：Next.js，默认端口 `3000`
- **后端**：Node HTTP API，默认端口 `3001`
- **数据库**：SQLite 文件（Docker 卷持久化）

浏览器通过环境变量 **`NEXT_PUBLIC_API_BASE_URL`** 访问后端，该地址必须是用户手机/电脑能访问的 **公网 URL**（不能写 Docker 内部主机名）。

## 一、用 Docker 在同一台云服务器上跑（推荐）

### 1. 准备一台云服务器

任选：**阿里云 ECS、腾讯云 CVM、华为云** 等，系统建议 **Ubuntu 22.04**，开放安全组端口：

- `3000`（前端，或通过 Nginx 只开放 80/443）
- `3001`（后端 API，建议仅内网或反代，不要长期裸奔在公网）

### 2. 安装 Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

### 3. 上传代码并配置环境

将本仓库同步到服务器（`git clone` 或 scp），在仓库根目录：

```bash
cp env.example .env
nano .env
```

务必设置：

- **`AUTH_SECRET`**：长随机字符串
- **`NEXT_PUBLIC_API_BASE_URL`**：填 **公网可访问的后端地址**  
  - 若暂时用 IP：`http://你的公网IP:3001`  
  - 有 API 子域名：`https://api.你的域名.com`（需先配好 HTTPS 与反代，见下文）

### 4. 构建并启动

```bash
docker compose up -d --build
```

浏览器访问：`http://服务器公网IP:3000`（若未配域名）。

### 5. 域名、备案与 HTTPS（面向中国大陆用户）

- **服务器在中国大陆境内**且使用 **国内域名解析到大陆机房**：一般需完成 **ICP 备案** 后才能长期用 80/443 正式对外提供网站服务（以云厂商要求为准）。
- **HTTPS**：建议使用 **Nginx/Caddy** 反向代理，申请免费证书（Let's Encrypt 或云厂商证书），对外只暴露 **443**，转发到本机 `127.0.0.1:3000`（前端）与 `127.0.0.1:3001`（API），并把 **`NEXT_PUBLIC_API_BASE_URL`** 设为 **`https://你的 API 域名`** 后 **重新构建前端镜像**（该变量在 `next build` 时打入静态资源）。

简化的 Nginx 思路（示例，域名请替换）：

- `https://www.example.com` → `proxy_pass http://127.0.0.1:3000`
- `https://api.example.com` → `proxy_pass http://127.0.0.1:3001`

修改 `.env` 中的 `NEXT_PUBLIC_API_BASE_URL` 后执行：

```bash
docker compose up -d --build web
```

## 二、中国香港 / 海外机房（免备案常见选择）

若服务器在 **香港、新加坡** 等，通常 **无大陆备案要求**，但大陆访问速度与运营商线路有关，可搭配 **CDN/全站加速**（按厂商文档配置）。

## 三、安全建议

- 不要将 `.env`、数据库文件提交到 Git。
- 生产环境务必使用 **HTTPS**。
- 定期备份 SQLite 卷或文件（`/data/app.sqlite` 对应卷 `api-sqlite`）。

## 四、故障排查

- 页面能开但接口 401/连不上：检查 **`NEXT_PUBLIC_API_BASE_URL`** 是否与浏览器访问的 API 地址一致，且已 **重新 build** 前端。
- 仅内网通、外网不通：检查云安全组、防火墙、Nginx 是否监听 `0.0.0.0`。

仓库内还提供：`Dockerfile.api`、`Dockerfile.web`、`docker-compose.yml`、根目录 `env.example`。
