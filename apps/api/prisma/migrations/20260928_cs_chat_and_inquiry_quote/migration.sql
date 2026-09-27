-- 客服对话 + 整柜询价报价（2026-09-28，老板拍板「都行」，含同意改表结构）
--
-- 只增不删：
--   ① 新建 cs_conversations（一个客户一条对话）、cs_messages（每条消息）两张表；
--   ② fcl_inquiries 加 8 列（报价金额 / 说明 / 时间 / 报价人、客户接受时间、转成哪个整柜 / 时间 / 操作人）。
-- 已有数据一行不动：新列全部可空、没有默认值要回填；线上那 1 条询价单照旧是「待处理」。
-- 全部 IF NOT EXISTS，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。
-- ⚠️ 列名全部下划线，schema.prisma 里一律 @map；索引 / 约束名照 Prisma 默认命名，免得 diff 以为缺了再建一份。

-- ① 对话：一个客户一条（company_id + client_id 唯一）
CREATE TABLE IF NOT EXISTS "cs_conversations" (
  "id"                   TEXT NOT NULL,
  "company_id"           TEXT NOT NULL,
  "client_id"            TEXT NOT NULL,
  "last_message_at"      TIMESTAMP(3),
  "last_message_preview" TEXT,
  "last_sender_role"     TEXT,
  "client_read_at"       TIMESTAMP(3),
  "staff_read_at"        TIMESTAMP(3),
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cs_conversations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "cs_conversations_company_id_client_id_key" ON "cs_conversations" ("company_id", "client_id");
CREATE INDEX IF NOT EXISTS "cs_conversations_company_id_last_message_at_idx" ON "cs_conversations" ("company_id", "last_message_at");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cs_conversations_client_id_fkey') THEN
    ALTER TABLE "cs_conversations"
      ADD CONSTRAINT "cs_conversations_client_id_fkey"
      FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ② 消息：文字、图片（存盘路径）
CREATE TABLE IF NOT EXISTS "cs_messages" (
  "id"              TEXT NOT NULL,
  "company_id"      TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "sender_id"       TEXT NOT NULL,
  "sender_role"     TEXT NOT NULL,
  "sender_name"     TEXT,
  "content"         TEXT,
  "image_path"      TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cs_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "cs_messages_conversation_id_created_at_idx" ON "cs_messages" ("conversation_id", "created_at");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cs_messages_conversation_id_fkey') THEN
    ALTER TABLE "cs_messages"
      ADD CONSTRAINT "cs_messages_conversation_id_fkey"
      FOREIGN KEY ("conversation_id") REFERENCES "cs_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ③ 整柜询价：报价 + 转整柜
ALTER TABLE "fcl_inquiries" ADD COLUMN IF NOT EXISTS "quote_amount_cny" DECIMAL(12,2);
ALTER TABLE "fcl_inquiries" ADD COLUMN IF NOT EXISTS "quote_note" TEXT;
ALTER TABLE "fcl_inquiries" ADD COLUMN IF NOT EXISTS "quoted_at" TIMESTAMP(3);
ALTER TABLE "fcl_inquiries" ADD COLUMN IF NOT EXISTS "quoted_by" TEXT;
ALTER TABLE "fcl_inquiries" ADD COLUMN IF NOT EXISTS "accepted_at" TIMESTAMP(3);
ALTER TABLE "fcl_inquiries" ADD COLUMN IF NOT EXISTS "fcl_container_id" TEXT;
ALTER TABLE "fcl_inquiries" ADD COLUMN IF NOT EXISTS "converted_at" TIMESTAMP(3);
ALTER TABLE "fcl_inquiries" ADD COLUMN IF NOT EXISTS "converted_by" TEXT;
-- 整柜被超管删掉时这一列置空（询价单留着，可以重新转）；不用 RESTRICT，免得删整柜被询价单卡住
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fcl_inquiries_fcl_container_id_fkey') THEN
    ALTER TABLE "fcl_inquiries"
      ADD CONSTRAINT "fcl_inquiries_fcl_container_id_fkey"
      FOREIGN KEY ("fcl_container_id") REFERENCES "containers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
