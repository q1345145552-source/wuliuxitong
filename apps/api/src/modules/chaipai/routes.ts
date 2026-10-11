import type { MinimalHttpApp } from "../../server";
import { registerChaipaiEventRoutes } from "./event-routes";
import { registerChaipaiManifestRoutes } from "./manifest-routes";
import { registerChaipaiPhotoRoutes } from "./photo-routes";

/** 对接拆派仓（2026-10-12）：拉清单、收回传、员工看派送照片。总开关 CHAIPAI_ENABLED 默认关，见 config.ts */
export function registerChaipaiRoutes(app: MinimalHttpApp): void {
  registerChaipaiManifestRoutes(app);
  registerChaipaiEventRoutes(app);
  registerChaipaiPhotoRoutes(app);
}
