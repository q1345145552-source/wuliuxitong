-- 客服对话：撤回 + 关联运单 / 整柜 + 浏览器系统通知（2026-10-02 老板拍板）
--
-- 只增不删：
--   ① cs_messages 加 5 列：撤回时间、关联的单（类型 / id / 发送时的单号 / 品名）；
--   ② 新建 cs_push_subscriptions：每个开了系统通知的浏览器一行。
-- 已有数据一行不动：新列全部可空、没有默认值要回填，老消息照旧显示。
-- 全部 IF NOT EXISTS，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。
-- ⚠️ 列名全部下划线，schema.prisma 里一律 @map；索引 / 约束名照 Prisma 默认命名，免得 diff 以为缺了再建一份。

-- ① 消息：撤回、关联的单
ALTER TABLE "cs_messages" ADD COLUMN IF NOT EXISTS "recalled_at" TIMESTAMP(3);
ALTER TABLE "cs_messages" ADD COLUMN IF NOT EXISTS "ref_type" TEXT;
ALTER TABLE "cs_messages" ADD COLUMN IF NOT EXISTS "ref_id" TEXT;
ALTER TABLE "cs_messages" ADD COLUMN IF NOT EXISTS "ref_no" TEXT;
ALTER TABLE "cs_messages" ADD COLUMN IF NOT EXISTS "ref_title" TEXT;

-- ② 系统通知的订阅：一个浏览器一行（endpoint 唯一）
CREATE TABLE IF NOT EXISTS "cs_push_subscriptions" (
  "id"         TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "role"       TEXT NOT NULL,
  "endpoint"   TEXT NOT NULL,
  "p256dh"     TEXT NOT NULL,
  "auth"       TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cs_push_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "cs_push_subscriptions_endpoint_key" ON "cs_push_subscriptions" ("endpoint");
CREATE INDEX IF NOT EXISTS "cs_push_subscriptions_company_id_role_idx" ON "cs_push_subscriptions" ("company_id", "role");
CREATE INDEX IF NOT EXISTS "cs_push_subscriptions_user_id_idx" ON "cs_push_subscriptions" ("user_id");
