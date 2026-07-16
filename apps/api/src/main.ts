// B-final: 完全切换到 Prisma + PostgreSQL（2026-05-20）
import { prisma } from "./db/prisma";
import { registerAdminRoutes } from "./modules/admin/routes";
import { registerClientAiRoutes } from "./modules/ai";
import { registerAdminOpsRoutes } from "./modules/admin-ops/routes";
import { registerAuthRoutes } from "./modules/auth/routes";
import { registerClientAddressRoutes } from "./modules/client-addresses/routes";
import { registerClientComplianceRoutes } from "./modules/client-compliance/routes";
import { registerContainerRoutes } from "./modules/containers/routes";
import { registerLoadingManifestRoutes } from "./modules/loading-manifests/routes";
import { registerFinanceRoutes } from "./modules/finance/routes";
import { registerShippingConfigRoutes } from "./modules/shipping-config/routes";
import { registerOrderRoutes } from "./modules/orders/routes";
import { registerShipmentRoutes } from "./modules/shipments/routes";
import { registerFclInquiryRoutes } from "./modules/fcl-inquiries/routes";
import { registerConsolidationRoutes } from "./modules/consolidation/routes";
import { createApp } from "./server";
import { startDailyExchangeRateScheduler } from "./modules/exchange-rate/rate-sync";
import { logger } from "./modules/core/logger";

const PORT = Number(process.env.PORT ?? 3001);

const app = createApp();

// 健康检查端点
app.get("/", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// 启动时做一次 Prisma 连接探测，让链路问题尽早暴露
prisma
  .$connect()
  .then(() => {
    logger.info("connected to PostgreSQL", { module: "prisma" });
  })
  .catch((err) => {
    logger.error("Prisma connection failed", { module: "prisma", error: String(err) });
    process.exit(1);
  });

registerAuthRoutes(app);
registerOrderRoutes(app);
registerShipmentRoutes(app);
registerClientAddressRoutes(app);
registerClientComplianceRoutes(app);
registerAdminRoutes(app);
registerAdminOpsRoutes(app);
registerContainerRoutes(app);
registerLoadingManifestRoutes(app);
registerFinanceRoutes(app);
registerShippingConfigRoutes(app);
registerFclInquiryRoutes(app);
registerConsolidationRoutes(app);
startDailyExchangeRateScheduler();

// ===== AI routes =====
registerClientAiRoutes(app);

// 优雅停机
process.on("SIGINT", async () => {
  logger.info("SIGINT received, closing Prisma...");
  await prisma.$disconnect();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, closing Prisma...");
  await prisma.$disconnect();
  process.exit(0);
});

app.listen(PORT, () => {
  logger.info(`API server running on http://localhost:${PORT}`, {
    dataSource: "PostgreSQL via Prisma",
    port: PORT,
  });
  logger.info("Registered routes: /auth/login, /auth/register, /client/orders, /admin/dashboard/overview, /client/ai/chat, /admin/containers/*, /client/shipments/track, /client/consolidation/tasks, /client/consolidation/prealerts");
});
