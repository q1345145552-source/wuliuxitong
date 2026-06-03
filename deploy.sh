#!/bin/bash
set -e

# =============================================
# 湘泰国际物流系统 - 一键部署脚本
# 使用: 先在服务器配置好 .env 文件
# 依赖: Docker + Docker Compose
# =============================================

SERVER="root@76.13.181.104"

echo "🚀 开始部署到 $SERVER ..."

ssh "$SERVER" 'set -e && cd /root/MyWebSite && echo "📦 拉取最新代码..." && git pull origin main && echo "🗄️  执行数据库迁移..." && npx prisma migrate deploy --schema=apps/api/prisma/schema.prisma && echo "🐳 构建并重启服务..." && docker compose up -d --build && echo "✅ 部署完成：" && docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'

echo "🎉 部署成功！"
echo "   前端: http://76.13.181.104:3000"
echo "   API:  http://76.13.181.104:3001"
