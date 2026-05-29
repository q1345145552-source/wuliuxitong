-- 为 users 表的 (phone, role) 添加唯一约束
-- 先清理可能的重复数据（保留最早注册的）
DELETE FROM users a USING users b
WHERE a.ctid < b.ctid
  AND a.phone = b.phone
  AND a.role = b.role;

ALTER TABLE "users" ADD CONSTRAINT "users_phone_role_key" UNIQUE ("phone", "role");
