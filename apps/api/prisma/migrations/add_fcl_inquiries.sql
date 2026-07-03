CREATE TABLE IF NOT EXISTS "fcl_inquiries" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_by_role" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "cargo_value" TEXT NOT NULL DEFAULT '',
    "cargo_weight" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL,
    "container_type" TEXT NOT NULL DEFAULT '1*40HQ',
    "service_type" TEXT NOT NULL DEFAULT '清提派',
    "loading_date" TEXT,
    "cert_file_name" TEXT,
    "cert_file_base64" TEXT,
    "product_images" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fcl_inquiries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "fcl_inquiries_company_id_status_idx" ON "fcl_inquiries"("company_id", "status");
CREATE INDEX IF NOT EXISTS "fcl_inquiries_company_id_created_at_idx" ON "fcl_inquiries"("company_id", "created_at" DESC);

ALTER TABLE "fcl_inquiries" ADD CONSTRAINT "fcl_inquiries_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
