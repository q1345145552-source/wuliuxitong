-- 整柜管理（2026-09-23）
--
-- 只增不删：给 containers 加一列 is_fcl（是不是整柜），默认 false。
-- 线上现有柜子全部落在 false 一侧 —— 也就是现在的拼柜，行为一点不变。
-- IF NOT EXISTS，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。
-- ⚠️ 列名下划线，schema.prisma 里用 @map("is_fcl")。

ALTER TABLE "containers" ADD COLUMN IF NOT EXISTS "is_fcl" BOOLEAN NOT NULL DEFAULT false;

-- 整柜列表按这一列筛，给它建个索引（跟现有 companyId+status 那个索引不冲突）
CREATE INDEX IF NOT EXISTS "containers_company_is_fcl_idx" ON "containers" ("company_id", "is_fcl");
