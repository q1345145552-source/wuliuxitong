import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { logger } from "../core/logger";
import { chaipaiConfig } from "./config";
import { fetchChaipaiDetail, fetchChaipaiPhoto } from "./read-client";

/**
 * 「派送照片」（2026-10-12）：拆派仓这票的全部照片（员工到仓拍的、转交时传的、司机签收拍的混在一起，拆派仓不分种类）。
 * 老板第 256 条：**只给员工看**（员工 / 管理员），客户看不到；客户看的签收单是尾端派送单里那张（自动登记时放进去的）。
 * 湘泰后台带只读密钥去拆派仓取，密钥不下发浏览器。轨迹弹窗每个页签（父单 / 子单）各查各的。
 */
export function registerChaipaiPhotoRoutes(app: MinimalHttpApp): void {
  const findShipment = async (trackingNo: string | undefined, companyId: string) => {
    const no = trackingNo?.trim();
    if (!no) return null;
    return prisma.shipment.findFirst({
      where: { trackingNo: no, companyId },
      select: { id: true, chaipaiState: { select: { shipmentId: true } } },
    });
  };

  app.get("/staff/shipments/chaipai-photos", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const shipment = await findShipment(req.query.trackingNo, auth.companyId);
    if (!shipment) { fail(res, 404, "NOT_FOUND", "运单不存在"); return; }
    const cfg = chaipaiConfig();
    // 开关关着：前端整块不显示，也不去拆派仓查
    if (!cfg) { ok(res, { state: "disabled", items: [], truncated: false }); return; }
    // 拆派仓从没回传过这票 = 没经过拆派仓，省掉每次打开轨迹都去查一次
    if (!shipment.chaipaiState) { ok(res, { state: "none", items: [], truncated: false }); return; }
    // 员工看的列表最多翻 10 页（200 张），多了页面上写「只显示了前 N 张」
    const detail = await fetchChaipaiDetail(cfg, shipment.id, { maxPages: 10, timeoutMs: 10000 });
    if (detail.kind === "notFound") { ok(res, { state: "none", items: [], truncated: false }); return; }
    if (detail.kind !== "ok") {
      logger.warn("派送照片：拆派仓暂时取不到", { shipmentId: shipment.id, 原因: detail.kind === "error" ? detail.reason : detail.kind });
      ok(res, { state: "unavailable", items: [], truncated: false });
      return;
    }
    // 拆派仓按 id 排（跟拍照时间无关），这里按拍照时间排
    const items = [...detail.value.photos].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    ok(res, { state: items.length > 0 ? "ok" : "none", items, truncated: detail.value.truncated });
  });

  app.get("/staff/shipments/chaipai-photo", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const photoId = req.query.photoId?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(photoId)) { fail(res, 400, "BAD_REQUEST", "照片编号不对"); return; }
    const shipment = await findShipment(req.query.trackingNo, auth.companyId);
    if (!shipment) { fail(res, 404, "NOT_FOUND", "运单不存在"); return; }
    const cfg = chaipaiConfig();
    if (!cfg) { fail(res, 404, "NOT_FOUND", "拆派仓对接没有开"); return; }
    // 照片是不是这票的，拆派仓那边会再核一次（domestic-read.service.ts 的 photo）
    const photo = await fetchChaipaiPhoto(cfg, shipment.id, photoId, { timeoutMs: 15000 });
    if (photo.kind === "ok") {
      ok(res, { contentType: photo.value.contentType, dataBase64: photo.value.bytes.toString("base64") });
      return;
    }
    if (photo.kind === "gone") { fail(res, 410, "NOT_FOUND", "照片已过保留期"); return; }
    if (photo.kind === "notFound") { fail(res, 404, "NOT_FOUND", "照片已不存在"); return; }
    logger.warn("派送照片：单张取不到", { shipmentId: shipment.id, photoId, 原因: photo.reason });
    fail(res, 502, "INTERNAL_ERROR", "暂时取不到照片");
  });
}
