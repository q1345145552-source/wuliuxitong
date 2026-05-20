-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "warehouse_ids" TEXT NOT NULL DEFAULT '[]',
    "password_hash" TEXT,
    "company_name" TEXT,
    "email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "batch_no" TEXT,
    "order_no" TEXT,
    "approval_status" TEXT NOT NULL DEFAULT 'approved',
    "item_name" TEXT NOT NULL,
    "product_quantity" INTEGER NOT NULL,
    "package_count" INTEGER NOT NULL,
    "package_unit" TEXT NOT NULL,
    "weight_kg" DECIMAL(10,2),
    "volume_m3" DECIMAL(10,3),
    "receivable_amount_cny" DECIMAL(12,2),
    "receivable_currency" TEXT NOT NULL DEFAULT 'CNY',
    "payment_status" TEXT NOT NULL DEFAULT 'unpaid',
    "paid_at" TIMESTAMP(3),
    "paid_by" TEXT,
    "payment_proof_file_name" TEXT,
    "payment_proof_mime" TEXT,
    "payment_proof_base64" TEXT,
    "payment_proof_uploaded_at" TIMESTAMP(3),
    "ship_date" TEXT,
    "domestic_tracking_no" TEXT,
    "transport_mode" TEXT NOT NULL,
    "receiver_name_th" TEXT NOT NULL,
    "receiver_phone_th" TEXT NOT NULL,
    "receiver_address_th" TEXT NOT NULL,
    "status_group" TEXT NOT NULL DEFAULT 'unfinished',
    "cargo_type" TEXT NOT NULL DEFAULT 'NORMAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "tracking_no" TEXT NOT NULL,
    "batch_no" TEXT,
    "container_no" TEXT,
    "current_status" TEXT NOT NULL,
    "current_location" TEXT,
    "weight_kg" DECIMAL(10,2),
    "volume_m3" DECIMAL(10,3),
    "package_count" INTEGER,
    "package_unit" TEXT,
    "transport_mode" TEXT,
    "domestic_tracking_no" TEXT,
    "warehouse_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_logs" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "operator_role" TEXT NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "remark" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_session_memory" (
    "key" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "intent" TEXT,
    "item_name" TEXT,
    "status_scope" TEXT,
    "time_hint" TEXT,
    "metric" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_session_memory_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ai_status_labels" (
    "status" TEXT NOT NULL,
    "label_zh" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_status_labels_pkey" PRIMARY KEY ("status")
);

-- CreateTable
CREATE TABLE "ai_knowledge_items" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_knowledge_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "session_id" TEXT,
    "question" TEXT NOT NULL,
    "answer_summary" TEXT NOT NULL,
    "referenced_order_ids" TEXT,
    "referenced_shipment_ids" TEXT,
    "queried_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_knowledge_gaps" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT,
    "question" TEXT NOT NULL,
    "answer_summary" TEXT NOT NULL,
    "knowledge_count_at_ask" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,

    CONSTRAINT "ai_knowledge_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_addresses" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "address_detail" TEXT NOT NULL,
    "lat" DECIMAL(10,6),
    "lng" DECIMAL(10,6),
    "label" TEXT,
    "is_default" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_documents" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "doc_type" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "content_base64" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_wallet_accounts" (
    "clientId" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_wallet_accounts_pkey" PRIMARY KEY ("clientId","currency")
);

-- CreateTable
CREATE TABLE "client_exchange_rates" (
    "base_currency" TEXT NOT NULL,
    "quote_currency" TEXT NOT NULL,
    "rate" DECIMAL(14,6) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_exchange_rates_pkey" PRIMARY KEY ("base_currency","quote_currency")
);

-- CreateTable
CREATE TABLE "staff_inbound_photos" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "content_base64" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_inbound_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_product_images" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "content_base64" TEXT NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_lmp_rates" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "route_code" TEXT NOT NULL,
    "supplier_name" TEXT NOT NULL,
    "transport_mode" TEXT NOT NULL,
    "season_tag" TEXT NOT NULL,
    "supplier_cost" DECIMAL(12,2) NOT NULL,
    "quote_price" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_lmp_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_customs_cases" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "shipment_id" TEXT,
    "order_id" TEXT,
    "status" TEXT NOT NULL,
    "remark" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_customs_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_lastmile_orders" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "carrier_name" TEXT NOT NULL,
    "external_tracking_no" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_lastmile_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_settlement_entries" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "client_receivable" DECIMAL(12,2) NOT NULL,
    "supplier_payable" DECIMAL(12,2) NOT NULL,
    "tax_fee" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_settlement_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "containers" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "container_no" TEXT NOT NULL,
    "container_type" TEXT NOT NULL,
    "loading_date" TIMESTAMP(3),
    "departure_date" TIMESTAMP(3),
    "eta" TIMESTAMP(3),
    "ata" TIMESTAMP(3),
    "customs_cleared_at" TIMESTAMP(3),
    "current_status" TEXT NOT NULL DEFAULT 'LOADING',
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "containers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_container_items" (
    "id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "container_id" TEXT NOT NULL,
    "loaded_volume_m3" DECIMAL(10,3) NOT NULL,
    "loaded_piece_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_container_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_locations" (
    "id" TEXT NOT NULL,
    "warehouse" TEXT NOT NULL,
    "location_code" TEXT NOT NULL,
    "shipment_id" TEXT,
    "in_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "out_at" TIMESTAMP(3),
    "aging_days" INTEGER NOT NULL DEFAULT 0,
    "is_alerted" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'OCCUPIED',
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "delivery_date" TIMESTAMP(3) NOT NULL,
    "driver_name" TEXT NOT NULL,
    "recipient_signed_name" TEXT,
    "delivery_pdf_url" TEXT,
    "signature_photo_url" TEXT,
    "disclaimer_version" TEXT NOT NULL DEFAULT 'v1-2026-05',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "cargo_type" TEXT NOT NULL,
    "customer_id" TEXT,
    "unit_price_usd" DECIMAL(10,2) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "billing_month" TEXT NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "paid_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "unpaid_amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "confirmed_at" TIMESTAMP(3),
    "confirm_proof_url" TEXT,
    "due_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "order_id" TEXT,
    "volume_m3" DECIMAL(10,3) NOT NULL,
    "unit_price_usd" DECIMAL(10,2) NOT NULL,
    "line_amount" DECIMAL(12,2) NOT NULL,
    "cargo_type" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "remark" TEXT,
    "recorded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_credit" (
    "customer_id" TEXT NOT NULL,
    "current_level" TEXT NOT NULL DEFAULT 'D',
    "credit_term_days" INTEGER NOT NULL DEFAULT 0,
    "credit_limit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "current_receivable" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "oldest_unpaid_days" INTEGER NOT NULL DEFAULT 0,
    "overdue_count" INTEGER NOT NULL DEFAULT 0,
    "evaluated_at" TIMESTAMP(3),
    "manually_adjusted" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_credit_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "credit_histories" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "snapshot_month" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "evaluator" TEXT NOT NULL,
    "reason" TEXT,
    "metrics" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "before_json" TEXT,
    "after_json" TEXT,
    "remark" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_company_id_idx" ON "users"("company_id");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "orders_company_id_client_id_idx" ON "orders"("company_id", "client_id");

-- CreateIndex
CREATE INDEX "orders_company_id_status_group_idx" ON "orders"("company_id", "status_group");

-- CreateIndex
CREATE INDEX "orders_batch_no_idx" ON "orders"("batch_no");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tracking_no_key" ON "shipments"("tracking_no");

-- CreateIndex
CREATE INDEX "shipments_company_id_current_status_idx" ON "shipments"("company_id", "current_status");

-- CreateIndex
CREATE INDEX "shipments_order_id_idx" ON "shipments"("order_id");

-- CreateIndex
CREATE INDEX "shipments_batch_no_idx" ON "shipments"("batch_no");

-- CreateIndex
CREATE INDEX "status_logs_shipment_id_changed_at_idx" ON "status_logs"("shipment_id", "changed_at");

-- CreateIndex
CREATE INDEX "ai_session_memory_updated_at_idx" ON "ai_session_memory"("updated_at");

-- CreateIndex
CREATE INDEX "ai_knowledge_items_company_id_created_at_idx" ON "ai_knowledge_items"("company_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_audit_logs_company_id_queried_at_idx" ON "ai_audit_logs"("company_id", "queried_at" DESC);

-- CreateIndex
CREATE INDEX "ai_knowledge_gaps_company_id_status_created_at_idx" ON "ai_knowledge_gaps"("company_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "client_addresses_client_id_updated_at_idx" ON "client_addresses"("client_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "client_documents_client_id_created_at_idx" ON "client_documents"("client_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "staff_inbound_photos_shipment_id_created_at_idx" ON "staff_inbound_photos"("shipment_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "order_product_images_company_id_order_id_created_at_idx" ON "order_product_images"("company_id", "order_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_lmp_rates_route_code_updated_at_idx" ON "admin_lmp_rates"("route_code", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "admin_customs_cases_status_updated_at_idx" ON "admin_customs_cases"("status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "admin_lastmile_orders_shipment_id_updated_at_idx" ON "admin_lastmile_orders"("shipment_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "admin_settlement_entries_order_id_updated_at_idx" ON "admin_settlement_entries"("order_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "containers_container_no_key" ON "containers"("container_no");

-- CreateIndex
CREATE INDEX "containers_company_id_current_status_idx" ON "containers"("company_id", "current_status");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_container_items_shipment_id_container_id_key" ON "shipment_container_items"("shipment_id", "container_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_locations_shipment_id_key" ON "warehouse_locations"("shipment_id");

-- CreateIndex
CREATE INDEX "warehouse_locations_warehouse_is_alerted_idx" ON "warehouse_locations"("warehouse", "is_alerted");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_locations_warehouse_location_code_key" ON "warehouse_locations"("warehouse", "location_code");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_shipment_id_key" ON "deliveries"("shipment_id");

-- CreateIndex
CREATE INDEX "pricing_rules_company_id_cargo_type_customer_id_idx" ON "pricing_rules"("company_id", "cargo_type", "customer_id");

-- CreateIndex
CREATE INDEX "invoices_company_id_status_idx" ON "invoices"("company_id", "status");

-- CreateIndex
CREATE INDEX "invoices_company_id_due_date_idx" ON "invoices"("company_id", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_customer_id_billing_month_key" ON "invoices"("customer_id", "billing_month");

-- CreateIndex
CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines"("invoice_id");

-- CreateIndex
CREATE INDEX "payments_invoice_id_paid_at_idx" ON "payments"("invoice_id", "paid_at");

-- CreateIndex
CREATE INDEX "credit_histories_customer_id_created_at_idx" ON "credit_histories"("customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_company_id_created_at_idx" ON "audit_logs"("company_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_logs" ADD CONSTRAINT "status_logs_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_audit_logs" ADD CONSTRAINT "ai_audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_addresses" ADD CONSTRAINT "client_addresses_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_wallet_accounts" ADD CONSTRAINT "client_wallet_accounts_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_inbound_photos" ADD CONSTRAINT "staff_inbound_photos_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_inbound_photos" ADD CONSTRAINT "staff_inbound_photos_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_product_images" ADD CONSTRAINT "order_product_images_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_product_images" ADD CONSTRAINT "order_product_images_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_customs_cases" ADD CONSTRAINT "admin_customs_cases_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_customs_cases" ADD CONSTRAINT "admin_customs_cases_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_lastmile_orders" ADD CONSTRAINT "admin_lastmile_orders_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_settlement_entries" ADD CONSTRAINT "admin_settlement_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_container_items" ADD CONSTRAINT "shipment_container_items_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_container_items" ADD CONSTRAINT "shipment_container_items_container_id_fkey" FOREIGN KEY ("container_id") REFERENCES "containers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_credit" ADD CONSTRAINT "customer_credit_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_histories" ADD CONSTRAINT "credit_histories_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_credit"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
