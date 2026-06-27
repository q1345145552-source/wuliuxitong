#!/bin/bash
set -e

# =============================================
# 湘泰国际物流系统 - 一键部署脚本
# 使用: 先在服务器配置好 .env 文件
# 依赖: Docker + Docker Compose
# =============================================

SERVER="${VPS_USER:-root}@${VPS_HOST:?请设置 VPS_HOST 环境变量，例如 export VPS_HOST=your-server-ip}"

echo "🚀 开始部署到 $SERVER ..."

ssh "$SERVER" 'set -e && cd /root/MyWebSite && echo "📦 拉取最新代码..." && git pull origin main && echo "🗄️  执行数据库迁移..." && npx prisma migrate deploy --schema=apps/api/prisma/schema.prisma && echo "🐳 构建并重启服务..." && docker compose up -d --build && echo "✅ 部署完成：" && docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'

echo "🎉 部署成功！"
echo "   前端: http://${VPS_HOST}:3000"
echo "   API:  http://${VPS_HOST}:3001"
