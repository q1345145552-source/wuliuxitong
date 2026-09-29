-- 业务单号不回收（2026-09-29，老板选 A「加一张『发过的号』记录表，号只往上加、删了也不再发」）
--
-- 只增不删：新建 number_sequences 一张表。已有的表和数据一行不动，已经发出去的号全都不变。
-- 表是空的也能用：第一次发号时按「库里现有最大号」接着往下发（见 apps/api/src/modules/core/number-sequence.ts）。
-- 全部 IF NOT EXISTS，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。

CREATE TABLE IF NOT EXISTS "number_sequences" (
    "name" TEXT NOT NULL,
    "last_value" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("name")
);
