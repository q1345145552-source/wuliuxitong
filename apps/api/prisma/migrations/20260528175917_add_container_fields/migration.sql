-- DropIndex
DROP INDEX "users_phone_role_key";

-- AlterTable
ALTER TABLE "containers" ADD COLUMN     "carrier_name" TEXT,
ADD COLUMN     "sealed_at" TIMESTAMP(3),
ADD COLUMN     "warehouse_id" TEXT;
