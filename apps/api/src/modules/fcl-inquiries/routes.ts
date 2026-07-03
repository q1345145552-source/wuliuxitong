import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";

export function registerFclInquiryRoutes(app: MinimalHttpApp): void {
  // 客户端提交整柜询价
  app.post("/client/fcl-inquiries", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      productName?: string; cargoValue?: string; cargoWeight?: string;
      address?: string; containerType?: string; serviceType?: string;
      loadingDate?: string; certFileName?: string; certFileBase64?: string;
      productImages?: string;
    };
    if (!body.productName?.trim() || !body.address?.trim()) {
      fail(res, 400, "BAD_REQUEST", "品名和地址为必填");
      return;
    }
    const created = await prisma.fclInquiry.create({
      data: {
        companyId: auth.companyId,
        clientId: auth.userId,
        createdBy: auth.userId,
        createdByRole: "client",
        productName: body.productName.trim(),
        cargoValue: body.cargoValue?.trim() || "",
        cargoWeight: body.cargoWeight?.trim() || "",
        address: body.address.trim(),
        containerType: body.containerType?.trim() || "1*40HQ",
        serviceType: body.serviceType?.trim() || "清提派",
        loadingDate: body.loadingDate?.trim() || null,
        certFileName: body.certFileName?.trim() || null,
        certFileBase64: body.certFileBase64?.trim() || null,
        productImages: body.productImages?.trim() || null,
        status: "pending",
      },
    });
    ok(res, { id: created.id, createdAt: created.createdAt.toISOString() });
  });

  // 客户端查看自己的询价
  app.get("/client/fcl-inquiries", async (req, res) => {
    const auth = requireRole(req, res, ["client", "staff", "admin"]);
    if (!auth) return;
    const where: any = { companyId: auth.companyId };
    if (auth.role === "client") where.clientId = auth.userId;
    const items = await prisma.fclInquiry.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    ok(res, {
      items: items.map((r) => ({
        id: r.id, clientId: r.clientId, productName: r.productName,
        cargoValue: r.cargoValue, cargoWeight: r.cargoWeight,
        address: r.address, containerType: r.containerType,
        serviceType: r.serviceType, loadingDate: r.loadingDate,
        certFileName: r.certFileName,
        certFileBase64: r.certFileBase64,
        productImages: (() => { try { return r.productImages ? JSON.parse(r.productImages) : []; } catch { return []; } })(),
        status: r.status, remark: r.remark,
        createdByRole: r.createdByRole,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  });

  // 员工端提交（可指定客户）
  app.post("/staff/fcl-inquiries", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      clientId?: string; productName?: string; cargoValue?: string;
      cargoWeight?: string; address?: string; containerType?: string;
      serviceType?: string; loadingDate?: string;
      certFileName?: string; certFileBase64?: string; productImages?: string;
    };
    if (!body.clientId?.trim() || !body.productName?.trim() || !body.address?.trim()) {
      fail(res, 400, "BAD_REQUEST", "客户、品名和地址为必填");
      return;
    }
    const created = await prisma.fclInquiry.create({
      data: {
        companyId: auth.companyId,
        clientId: body.clientId.trim(),
        createdBy: auth.userId,
        createdByRole: "staff",
        productName: body.productName.trim(),
        cargoValue: body.cargoValue?.trim() || "",
        cargoWeight: body.cargoWeight?.trim() || "",
        address: body.address.trim(),
        containerType: body.containerType?.trim() || "1*40HQ",
        serviceType: body.serviceType?.trim() || "清提派",
        loadingDate: body.loadingDate?.trim() || null,
        certFileName: body.certFileName?.trim() || null,
        certFileBase64: body.certFileBase64?.trim() || null,
        productImages: body.productImages?.trim() || null,
        status: "pending",
      },
    });
    ok(res, { id: created.id, createdAt: created.createdAt.toISOString() });
  });
}
