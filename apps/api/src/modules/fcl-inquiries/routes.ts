import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { parseNumericStrict } from "../core/int-guard";
import { canSeeOperatorIdentity } from "../core/operator-visibility";

/**
 * 2026-09-01（Codex 复核收尾）：分页参数的严格校验。
 * 原来 page 只用 parseInt 卡了最小值：传一长串 9，parseInt 会算出超出
 * 安全整数的浮点数，skip 跟着超界，Prisma 直接 500；`1e400` 这类写法
 * 哪天被换成 Number(...) 就是 Infinity，同样炸。
 * 规矩：没传/传空串用默认值；传了就必须是正的安全整数（Number.isSafeInteger），
 * 不是就返回 null，由调用处 400 中文报错。
 */
function parsePageParam(raw: unknown, fallback: number): number | null {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return fallback;
  const n = parseNumericStrict(raw);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

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
    const isClient = auth.role === "client";
    const where: any = { companyId: auth.companyId };
    if (isClient) where.clientId = auth.userId;
    /* 2026-08-31（Codex 二轮）：列表加真分页，默认 50、上限 200，total 是真实总数。
       原来一次全量返回，还把认证文件 Base64 和产品图片整包下发——
       页面表格根本不显示这些，纯浪费流量。大字段挪到下面的 detail 接口按需取。 */
    // 2026-09-01（Codex 复核收尾）：page/pageSize 改用严格校验，非法直接 400（见文件头 parsePageParam）
    const page = parsePageParam(req.query.page, 1);
    if (page === null) { fail(res, 400, "BAD_REQUEST", "页码不合法"); return; }
    const pageSizeRaw = parsePageParam(req.query.pageSize, 50);
    if (pageSizeRaw === null) { fail(res, 400, "BAD_REQUEST", "每页条数不合法"); return; }
    const pageSize = Math.min(pageSizeRaw, 200); // 上限维持 200，传再大也只给 200
    // skip 再 clamp 一道当第二道保险：就算上面漏了，也绝不把 Infinity/超界数塞给 Prisma
    const skip = Math.min((page - 1) * pageSize, Number.MAX_SAFE_INTEGER);
    const [total, items] = await Promise.all([
      prisma.fclInquiry.count({ where }),
      prisma.fclInquiry.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        // 只取表格要用的小字段，certFileBase64 / productImages 连库都不读
        select: {
          id: true, clientId: true, productName: true,
          cargoValue: true, cargoWeight: true, address: true,
          containerType: true, serviceType: true, loadingDate: true,
          certFileName: true, status: true, remark: true,
          createdByRole: true, createdAt: true,
        },
      }),
    ]);
    ok(res, {
      items: items.map((r) => ({
        id: r.id, clientId: r.clientId, productName: r.productName,
        cargoValue: r.cargoValue, cargoWeight: r.cargoWeight,
        address: r.address, containerType: r.containerType,
        serviceType: r.serviceType, loadingDate: r.loadingDate,
        certFileName: r.certFileName,
        status: r.status,
        // 2026-08-31（Codex 二轮）：remark 是管理员内部备注（可能写着利润），
        // 客户角色一律不给——照 containers 那边 isClient 摘字段的写法
        remark: isClient ? undefined : r.remark,
        // 2026-09-15：是员工代填还是客户自己提交的，只给超级管理员（前端没显示，但接口里有就算漏）
        createdByRole: canSeeOperatorIdentity(auth.role) ? r.createdByRole : undefined,
        createdAt: r.createdAt.toISOString(),
      })),
      page,
      pageSize,
      total,
    });
  });

  // 按 id 取单条详情（大字段只在这里给）——2026-08-31（Codex 二轮）新增
  app.get("/client/fcl-inquiries/detail", async (req, res) => {
    const auth = requireRole(req, res, ["client", "staff", "admin"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "缺少询价单 id"); return; }
    const isClient = auth.role === "client";
    const where: any = { id, companyId: auth.companyId };
    if (isClient) where.clientId = auth.userId; // 客户只能看自己的
    const r = await prisma.fclInquiry.findFirst({ where });
    if (!r) { fail(res, 404, "NOT_FOUND", "询价记录不存在"); return; }
    ok(res, {
      id: r.id, clientId: r.clientId, productName: r.productName,
      cargoValue: r.cargoValue, cargoWeight: r.cargoWeight,
      address: r.address, containerType: r.containerType,
      serviceType: r.serviceType, loadingDate: r.loadingDate,
      certFileName: r.certFileName,
      certFileBase64: r.certFileBase64,
      /* 2026-09-01（终验收尾）：契约承诺 productImages 一定是数组，这里把承诺做实。
         库里这列存的是任意字符串（两条创建路都只收 string、不校验形状）：
         正常前端写入的是 JSON 数组，但直连 API 或历史数据可能存着 JSON 对象——
         夹具实测就返回过对象。出口统一规整：
         数组原样给；单个对象包成 [对象]（别用 Object.values，会把 {fileName,base64}
         拆成两个碎片）；标量 / 解析失败 / 空值一律给 []。
         目前 detail 接口前端还没人调（只在注释里提过），规整不会碰坏任何调用方。 */
      productImages: (() => {
        try {
          const parsed = r.productImages ? JSON.parse(r.productImages) : [];
          if (Array.isArray(parsed)) return parsed;
          if (parsed && typeof parsed === "object") return [parsed];
          return [];
        } catch { return []; }
      })(),
      status: r.status,
      // 同列表：内部备注不给客户
      remark: isClient ? undefined : r.remark,
      // 同列表：提交人角色只给超级管理员（2026-09-15）
      createdByRole: canSeeOperatorIdentity(auth.role) ? r.createdByRole : undefined,
      createdAt: r.createdAt.toISOString(),
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
    // 2026-08-31（Codex 二轮）：先核对客户是不是本公司的（照抄 client-compliance 的写法）。
    // 原来员工随便填个别家公司的客户编号也能建询价，将来接了第二家公司就串了。
    const client = await prisma.user.findFirst({
      where: { id: body.clientId.trim(), companyId: auth.companyId, role: "client" },
      select: { id: true },
    });
    if (!client) { fail(res, 404, "NOT_FOUND", "客户不存在或不属于本公司"); return; }
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
