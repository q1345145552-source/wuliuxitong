#!/usr/bin/env bash
# 在 CI 里跑一项「要连数据库」的测试，并且**不许它偷偷跳过**。
#
# 为什么要这个包装：这几个脚本为了防止误连生产库，遇到不认识的数据库会打印
# 「⚠️ 跳过」然后**正常退出（退出码 0）**。在 CI 里那就是一个假绿 ——
# GitHub 显示通过，其实一行都没跑（2026-09-25 之前一直是这样）。
# 这里把输出接下来查一遍，发现「跳过」直接判失败。
set -euo pipefail
task="${1:?用法: run-db-test.sh <npm 脚本名>}"
log="$(mktemp)"

set -o pipefail
npm run "$task" 2>&1 | tee "$log"

if grep -q "⚠️ 跳过" "$log"; then
  echo "::error::$task 打印了「跳过」—— 数据库没接上，这一项等于没测"
  exit 1
fi
echo "✅ $task 真跑了（没有跳过）"
