-- 财务系统2 扣货上报（2026-11-19；约定：财务系统2 docs/物流系统接口约定.md 第 11 节；老板 2026-11-19 答「放货拦截 2、6」）
--
-- 只加不删，不碰任何现有数据。四个新列，全部可空、没有默认值：
--   finance2_hold_logs.report_status    拆派仓把扣着的货派出去了（kind = chaipai）报给财务没有：pending / sent / rejected
--   finance2_hold_logs.reported_at      报成（sent）或被拒（rejected）的时间
--   finance2_hold_logs.report_error     最近一次没报成的原因（不含密钥）
--   finance2_hold_state.unavailable_report  「拿不到扣货名单」报给财务没有：pending / sent / rejected（又取到名单时据此报一次「恢复了」）
-- 全部 IF NOT EXISTS，重复执行不会出错。必须排在 20261119_finance2_holds 后面（目录名按字母排，holds_ 在 holds 之后）。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成。语句照 `prisma migrate diff` 对 schema.prisma 的输出抄的。

-- AlterTable
ALTER TABLE "finance2_hold_logs" ADD COLUMN IF NOT EXISTS "report_status" TEXT;
ALTER TABLE "finance2_hold_logs" ADD COLUMN IF NOT EXISTS "reported_at" TIMESTAMP(3);
ALTER TABLE "finance2_hold_logs" ADD COLUMN IF NOT EXISTS "report_error" TEXT;

-- AlterTable
ALTER TABLE "finance2_hold_state" ADD COLUMN IF NOT EXISTS "unavailable_report" TEXT;
