-- 对接海外仓财务系统的两张表（2026-11-04；老板原话：「登陆一次账号后就可以一直看到物流系统的运单状态了」）
--
-- 只加不删，不碰任何现有表的数据：
--   ① finance_link_requests —— 财务系统来申请授权的一次请求（10 分钟过期），一次性码只存哈希；
--   ② finance_link_authorizations —— 长期只读授权（财务的一个仓 + 物流的一个账号），长期授权只存 SHA-256。
-- 两张表都不加外键（不跟用户表的删除搅在一起）。全部 IF NOT EXISTS，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。
--    语句照 `prisma migrate diff` 对 schema.prisma 的输出抄的。

CREATE TABLE IF NOT EXISTS "finance_link_requests" (
    "id" TEXT NOT NULL,
    "warehouse_ref" TEXT NOT NULL,
    "warehouse_name" TEXT NOT NULL,
    "user_id" TEXT,
    "code_hash" TEXT,
    "code_expires_at" TIMESTAMP(3),
    "code_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_link_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "finance_link_authorizations" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "warehouse_ref" TEXT NOT NULL,
    "warehouse_name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "password_fingerprint" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    CONSTRAINT "finance_link_authorizations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "finance_link_requests_expires_at_idx" ON "finance_link_requests"("expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "finance_link_authorizations_token_hash_key" ON "finance_link_authorizations"("token_hash");
CREATE INDEX IF NOT EXISTS "finance_link_authorizations_user_id_warehouse_ref_idx" ON "finance_link_authorizations"("user_id", "warehouse_ref");
