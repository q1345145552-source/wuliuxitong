#!/bin/bash
set -e
ssh root@76.13.181.104 << 'EOF'
cd /root/MyWebSite
git pull
docker compose build web --no-cache
docker compose up -d
docker ps
EOF
