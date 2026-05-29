-- Add split-shipment fields to Shipment model
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "parent_tracking_no" TEXT;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "item_name" TEXT;
CREATE INDEX IF NOT EXISTS "shipments_parent_tracking_no_idx" ON "shipments" ("parent_tracking_no");
