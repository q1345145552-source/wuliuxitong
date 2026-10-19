-- 员工账号加备注（2026-10-20，老板：「给员工账号备注是哪里的员工，比如义乌仓管，广州仓管，泰国员工」→「管理员给员工账号进行备注」）
--
-- 只加不删：users 表加一列 remark（可空），不回填、不动现有任何一行（现有员工号这一格是空的，超管在「员工管理」里点「改备注」补）。
-- IF NOT EXISTS，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（同 20261006 那份的说明）。

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "remark" TEXT;
