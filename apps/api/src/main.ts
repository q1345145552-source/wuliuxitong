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
import { createApp } from "./server";
import { startDailyExchangeRateScheduler } from "./modules/exchange-rate/rate-sync";

const PORT = Number(process.env.PORT ?? 3001);

const app = createApp();

// 启动时做一次 Prisma 连接探测，让链路问题尽早暴露
prisma
  .$connect()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log("[prisma] connected to PostgreSQL");
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[prisma] connection failed:", err);
    process.exit(1);
  });

// ===== Core business routes（所有模块已切换到 Prisma；第二个参数 undefined 仅为兼容签名）=====
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _legacy: any = undefined;
registerAuthRoutes(app, _legacy);
registerOrderRoutes(app, _legacy);
registerShipmentRoutes(app, _legacy);
registerClientAddressRoutes(app, _legacy);
registerClientComplianceRoutes(app, _legacy);
registerAdminRoutes(app, _legacy);
registerAdminOpsRoutes(app, _legacy);
registerContainerRoutes(app);
registerLoadingManifestRoutes(app);
registerFinanceRoutes(app);
registerShippingConfigRoutes(app);
startDailyExchangeRateScheduler();

// ===== AI routes =====
registerClientAiRoutes(app, _legacy);

// 优雅停机
process.on("SIGINT", async () => {
  // eslint-disable-next-line no-console
  console.log("\n[api] SIGINT received, closing Prisma...");
  await prisma.$disconnect();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] running on http://localhost:${PORT}`);
  console.log("[api] data source: PostgreSQL via Prisma");
  console.log("[api] POST /auth/login");
  console.log("[api] POST /auth/register");
  console.log("[api] GET  /client/orders");
  console.log("[api] GET  /admin/dashboard/overview");
  console.log("[api] POST /client/ai/chat");
  // 新增：Container（柜子）& 出柜追踪
  console.log("[api] GET  /admin/containers                    柜列表");
  console.log("[api] GET  /admin/containers/detail?id=xxx      柜详情（含装载运单）");
  console.log("[api] POST /admin/containers                    新建柜子");
  console.log("[api] POST /admin/containers/status             变更柜子状态");
  console.log("[api] POST /admin/containers/load               装柜");
  console.log("[api] DELETE /admin/containers/load?id=xxx      卸柜");
  console.log("[api] GET  /client/shipments/track?trackingNo=xxx  客户追踪（含出柜信息）");
  console.log("[api] ...（其他路由日志已折叠）");
});
