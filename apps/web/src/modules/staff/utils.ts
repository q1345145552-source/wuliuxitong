import { shipmentStatusZh as sharedShipmentStatusZh, shipmentStatusWithPartialZh as sharedShipmentStatusWithPartialZh } from "../shipment/shipment-status";

import type { ShipmentItem } from "../../services/business-api";
import type { RepairStaffShipmentOrderLinksResult } from "../../services/business-api";
import type { PrealertEditDraft, ShipmentOrderEditDraft } from "./types";

/** 与后端 STATUS_FLOW 完全一致。 */
export const SHIPMENT_STATUS_FLOW = [
  "created",
  // 2026-09-02 进流程：货到国内仓（已入库），排在暂缓柜前面
  "inWarehouseCN",
  "holdLoading",
  "loaded",
  "customsInspectCn",
  "inspectClearedCn",
  "exportCleared",
  "delayDeparted",
  "etaUpdated",
  "portClosed",
  "berthed",
  "departed",
  "delayInTransit",
  "arrivedPort",
  "customsInspectTh",
  "inspectClearedTh",
  "customsTH",
  "customsCleared",
  "unloading",
  "inWarehouseTH",
  "deliveryBooked",
  "outForDelivery",
  "delivered",
] as const;

/* SHIPMENT_DELAY_STATUSES（可跳过的中间态）2026-08-13 删除：
   下拉框改成「后面的都能直接选」之后，没有谁需要单独标记哪几个可跳过了。
   后端的 DELAY_STATUSES 仍然保留 —— 那边管的是别的事，别顺手删掉。 */

export const SHIPMENT_EXCEPTION_STATUSES = new Set(["exception", "returned", "cancelled"]);

/**
 * 运单系统状态转中文（列表展示）。
 */
export function shipmentStatusZh(status: string | undefined): string {
  // 对照表挪到 modules/shipment/shipment-status.ts，三端共用一份，
  // 免得客户端那份漏配状态时直接把英文吐给用户（2026-08-07）。
  return sharedShipmentStatusZh(status);
}

/**
 * 运单状态转中文，子单进度不一样时补一句「（部分已放行）」（2026-09-16）。
 * 主状态、分组、筛选口径一个字不动，只是把话说全 —— 逻辑在三端共用那份里。
 */
export function shipmentStatusWithPartialZh(status: string | undefined, partialAhead?: string): string {
  return sharedShipmentStatusWithPartialZh(status, partialAhead);
}

/**
 * 仓库 ID 转中文仓名。
 */
export function warehouseLabelFromId(warehouseId: string | undefined): string {
  if (!warehouseId) return "—";
  const map: Record<string, string> = {
    wh_yiwu_01: "义乌仓",
    wh_guangzhou_01: "广州仓",
    wh_dongguan_01: "东莞仓",
    wh_shenzhen_01: "深圳仓",
  };
  return map[warehouseId] ?? warehouseId;
}

/**
 * 运输方式展示。
 */
export function transportModeLabel(mode: string | undefined): string {
  if (mode === "sea") return "海运";
  if (mode === "land") return "陆运";
  return mode ?? "—";
}

/**
 * 截断过长文本。
 */
export function truncateText(s: string | undefined, max: number): string {
  if (!s?.trim()) return "—";
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * 数字列格式化。
 */
/** 长宽高来自产品行；一票有多个不同尺寸时拼成「60/50」。员工端、客户端导出共用同一份口径 */
export function productDim(
  products: Array<{ lengthCm?: number | null; widthCm?: number | null; heightCm?: number | null }> | undefined,
  key: "lengthCm" | "widthCm" | "heightCm",
): number | string {
  const vals = (products ?? []).map((p) => p[key]).filter((v): v is number => v != null);
  if (vals.length === 0) return "-";
  const uniq = Array.from(new Set(vals));
  return uniq.length === 1 ? uniq[0] : uniq.join("/");
}

export function formatMetric(n: number | undefined | null, digits = 3): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(digits);
}

/**
 * 根据长宽高（厘米）计算体积（立方米）：长×宽×高÷1,000,000。
 */
export function volumeM3FromDimensionsCm(lengthCm: number, widthCm: number, heightCm: number): number {
  return (lengthCm * widthCm * heightCm) / 1_000_000;
}

/**
 * 时间格式化。
 */
export function formatDateTime(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  return iso.slice(0, 16).replace("T", " ");
}

/**
 * UTC/Bangkok 时间 → 北京时间中文格式：2026年7月16日 14点30分
 * 后端存的是 UTC，toLocaleString("zh-CN", {timeZone:"Asia/Shanghai"}) 自动+8。
 */
export function formatBeijingTime(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return fallback;
    return d.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).replace(/:(\d{2})$/, "点$1分").replace("日 ", "日 ");
  } catch {
    return fallback;
  }
}

/**
 * 简短版北京时间：2026-07-16 14:30（列表用）
 */
export function formatBeijingTimeShort(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return fallback;
    return d.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).replace(/\//g, "-");
  } catch {
    return fallback;
  }
}

/**
 * 将体积（立方米）格式化为字符串，便于提交表单。
 */
export function formatVolumeM3String(m3: number): string {
  if (!Number.isFinite(m3) || m3 <= 0) return "";
  return String(Number(m3.toFixed(6)));
}

export function shipmentShipDateToLocalInput(shipDate: string | undefined): string {
  if (!shipDate?.trim()) return "";
  const s = shipDate.trim();
  const datePart = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return "";
  if (s.length >= 16 && (s.includes("T") || s.includes(" "))) {
    const sep = s.includes("T") ? "T" : " ";
    const rest = sep === "T" ? s.slice(11) : s.slice(11);
    const hm = rest.slice(0, 5);
    if (/^\d{2}:\d{2}$/.test(hm)) return `${datePart}T${hm}`;
  }
  return `${datePart}T12:00`;
}

/**
 * 计算运单状态下拉可选目标（与后端 canTransit 规则一致）。
 */
export function getValidShipmentStatusTargets(fromStatus: string): string[] {
  const from = fromStatus?.trim() || "created";
  const out = new Set<string>();
  out.add(from);
  if (SHIPMENT_EXCEPTION_STATUSES.has(from)) {
    SHIPMENT_EXCEPTION_STATUSES.forEach((s) => out.add(s));
    return Array.from(out);
  }
  const fromIdx = SHIPMENT_STATUS_FLOW.indexOf(from as (typeof SHIPMENT_STATUS_FLOW)[number]);
  if (fromIdx >= 0) {
    /* 后面的环节全部放出来，员工可以直接跳，不用一格一格点（2026-08-13 用户定的）。
     *
     * 原来的规矩是「只放下一格，遇到延迟类才继续往后放一格」。
     * 加了 9 个环节之后这条规矩会出事：暂缓柜、海关查验、封港这些**出了状况才有**的环节
     * 全变成必经之路 —— 「已创建」的下一格是「暂缓柜」，等于逼着每票货都先点一下暂缓，
     * 这是给正常的货编造没发生过的事。用户原话：「可以直接跳过就行，不要一个一个点」。
     *
     * ⚠️ 只放**后面**的，往回退一格都不给 —— 退回去要走「撤销」，那边会连轨迹一起删干净。
     * ⚠️ 后端 canTransitLoose 本来就只要求「往前不往后」，这里放宽后两边口径才真正一致。
     */
    for (let i = fromIdx + 1; i < SHIPMENT_STATUS_FLOW.length; i += 1) {
      out.add(SHIPMENT_STATUS_FLOW[i]!);
    }
  }
  SHIPMENT_EXCEPTION_STATUSES.forEach((s) => out.add(s));
  return Array.from(out);
}

/**
 * 将「修复关联」接口结果转为用户可见的提示文案。
 */
export function formatRepairShipmentOrderLinkToast(result: RepairStaffShipmentOrderLinksResult): string {
  if (result.repairedCount > 0) {
    return result.repairedCount === 1
      ? "已补建订单并关联该运单，可保存订单信息"
      : `已补建订单并关联 ${result.repairedCount} 条运单`;
  }
  const first = result.skipped[0];
  if (!first) return "当前没有需要修复的运单";
  if (first.reason === "already_linked") return "该运单已有关联订单";
  if (first.reason === "shipment_not_found") return "未找到运单或无权访问";
  if (first.reason === "no_company_user") return "公司下无可用用户，无法补建订单";
  if (first.reason.startsWith("insert_failed:")) return `补建订单失败：${first.reason.slice("insert_failed:".length)}`;
  return `未能修复：${first.reason}`;
}

/**
 * 由运单行构造订单详情编辑草稿。
 */
export function buildShipmentOrderEditDraft(item: ShipmentItem): ShipmentOrderEditDraft {
  return {
    trackingNo: item.trackingNo ?? "",
    warehouseId: item.warehouseId ?? "wh_yiwu_01",
    batchNo: item.batchNo ?? "",
    itemName: item.itemName ?? "",
    domesticTrackingNo: item.domesticTrackingNo ?? "",
    productQuantity: item.productQuantity != null ? String(item.productQuantity) : "",
    packageCount: item.packageCount != null ? String(item.packageCount) : "",
    packageUnit: item.packageUnit === "bag" ? "bag" : "box",
    weightKg: item.weightKg != null ? String(item.weightKg) : "",
    volumeM3: item.volumeM3 != null ? String(item.volumeM3) : "",
    orderCreatedDate: item.arrivedAt ? item.arrivedAt.slice(0, 10) : "",
    transportMode: item.transportMode === "land" ? "land" : "sea",
    shipLocal: shipmentShipDateToLocalInput(item.shipDate),
    receiverAddressTh: item.receiverAddressTh ?? "",
    containerNo: item.containerNo ?? "",
    paymentStatus: item.paymentStatus === "paid" ? "paid" : "unpaid",
    destinationCountry: "泰国",
    customsDeclaration: "none",
    remark: item.remark ?? "",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildPrealertDraft(item: any): PrealertEditDraft {
  const firstProduct = item.products?.[0];
  return {
    warehouseId: item.warehouseId ?? "",
    itemName: item.itemName ?? "",
    packageCount: item.packageCount ?? 0,
    packageUnit: (item.packageUnit as "bag" | "box") ?? "box",
    productQuantity: item.productQuantity ?? 0,
    weightKg: item.weightKg ?? 0,
    volumeM3: item.volumeM3 ?? 0,
    domesticTrackingNo: (firstProduct?.domesticTrackingNo || item.domesticTrackingNo) ?? "",
    transportMode: (item.transportMode as "sea" | "land") ?? "sea",
    shipDate: item.shipDate?.slice(0, 10) ?? "",
  };
}

/**
 * 确认收货前的校验 + 组装请求体 —— **员工端和管理员端共用一份**。
 *
 * ════════════════════════════════════════════════════════════════════
 * 2026-08-29（第十轮之后）为什么要有这个
 * ════════════════════════════════════════════════════════════════════
 *
 * 三件事凑在一起，把「确认收货」这个每天都在用的动作变成了雷：
 *
 * 1. **弹窗里一道校验都没有**，draft 里的数字原样发出去。
 *
 * 2. 编辑框的 onChange 是 `Number(e.target.value || 0)` ——
 *    员工把重量框**清空**，草稿里当场变成 `0`，界面上也显示 0。
 *
 * 3. 我上一轮把后端收紧成「传了就必须大于 0」。于是前端那个 `0`
 *    会被后端 400 打回来 —— 而 `buildPrealertDraft` 对**本来就没填重量**的单子
 *    也是给 `0`。生产库只读查过：**有 8 张待确认收货的单子没填重量/方数**，
 *    也就是说这 8 张**根本确认不了收货**。这是我上一轮改后端引入的。
 *
 * 所以这里的规矩是：
 *   · 箱数是必填的业务字段 → 必须是正整数，当场拦住并说人话
 *   · 重量/方数是**可填可不填**的 → 空着或 0 就**根本不发这个字段**
 *     （后端的语义是「没传 = 不改」，而不是「传 0 = 清零」）
 *
 * ⚠️ 别把「空着」翻译成 0 发出去。0 和「没填」在这个系统里是两回事：
 *    0 方会让仓库版集货按「方数 × 单价」算出 0 元。
 */
export function validateReceiveDraft(
  draft: {
    packageCount: number | string;
    productQuantity?: number | string;
    weightKg?: number | string;
    volumeM3?: number | string;
  },
  /**
   * 这张单**原来**的重量/体积。传进来是为了识别「员工把原有的数清空了」——
   * 那种情况必须当场说清楚，不能静默保留旧值。不传就跳过那道检查。
   */
  original?: { weightKg?: number | string | null; volumeM3?: number | string | null },
): string | null {
  const pkg = Number(String(draft.packageCount ?? "").trim());
  if (!Number.isFinite(pkg) || !Number.isInteger(pkg) || pkg <= 0) {
    return "箱数必须填正整数（收到的货不可能是 0 件）";
  }

  /**
   * ⚠️⚠️ **产品数量：前后端口径必须一样**（2026-08-29 第十一轮改）。
   * 上一版这里允许 `0`，而后端要求**正整数** —— 复核实测：
   *   前端校验通过 → 发出 `productQuantity: 0` → 后端 400
   * 员工什么都没做错，点了确认才被打回来，还看不懂为什么。
   * **「前端放行、后端拒绝」比两边都不管更糟** —— 用户白填一遍。
   */
  const rawQty = draft.productQuantity;
  if (rawQty !== undefined && rawQty !== null && String(rawQty).trim() !== "" && Number(rawQty) !== 0) {
    const q = Number(String(rawQty).trim());
    if (!Number.isFinite(q) || !Number.isInteger(q) || q <= 0) {
      return "产品数量填了就必须是正整数（不填就空着）";
    }
  }

  /**
   * 重量和体积。三道：
   *  ① 填了就必须大于 0 —— 负数/乱填**不许被静默吞掉**（第十一轮）：
   *     上一版 `optionalNumberForReceive` 对负数返回 `undefined` =「当没填」，
   *     员工填了 -5kg，页面提示**成功**、库里还是旧重量，他以为改了其实没改。
   *  ② **按数据库精度判**（第十二轮补）：上一版只判「大于 0」，
   *     复核实测前端放行 `weightKg=0.001` / `volumeM3=0.0001`，
   *     而后端按 `Decimal(10,2)` / `Decimal(10,3)` 拒绝 —— 又是「前端放行、后端拒绝」。
   *     ⚠️ 两列精度不一样（重量 2 位、体积 3 位），别拿同一套去卡。
   *  ③ 舍完变成 0 的也要拦（0.001kg 舍到 2 位就是 0.00）。
   * ⚠️ 舍入必须跟后端**同一个算法**：`Math.round((n + EPSILON) * 10^s) / 10^s`。
   */
  for (const [label, raw, scale] of [
    ["重量", draft.weightKg, 2],
    ["体积", draft.volumeM3, 3],
  ] as Array<[string, unknown, number]>) {
    if (raw === undefined || raw === null) continue;
    const t = String(raw).trim();
    if (t === "" || Number(t) === 0) continue; // 空着 / 0 = 没填，交给 optionalNumberForReceive 省略
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) {
      return `${label}填了就必须大于 0（不填就空着）`;
    }
    const f = 10 ** scale;
    const stored = Math.round((n + Number.EPSILON) * f) / f;
    if (stored !== n) {
      return `${label}最多只能有 ${scale} 位小数（多的位数会被系统抹掉，跟你填的对不上）`;
    }
    if (stored === 0) {
      return `${label}太小了，存进系统会变成 0 —— 请检查是不是填错了单位`;
    }
  }

  /**
   * ⚠️⚠️ **「把原来的数清空」不许静默保留旧值**（2026-08-29 第十二轮补）。
   *
   * 复核实测：员工把原来填着的重量清空 → 页面显示空、提示**保存成功** →
   * 数据库里**还是旧重量**。他以为改了，其实没改，而且没有任何提示。
   *
   * 病根是我上一轮的取舍：「空着 = 不发这个字段」。
   * 那个取舍对「本来就没填」是对的，对「本来有、现在想清掉」就是错的 ——
   * 这两种情况在草稿里长得一模一样（都是 0/空）。
   *
   * 后端没有「把重量清空」这个能力（`undefined` = 不改），所以真做不到清零。
   * 既然做不到，就**明说**，别让员工以为做到了。
   * ⚠️ 以后想要「真的能清空」，得后端加一个显式的清除语义
   *    （比如传 `null` 表示清空），不是前端糊。
   */
  if (original) {
    for (const [label, now, before] of [
      ["重量", draft.weightKg, original.weightKg],
      ["体积", draft.volumeM3, original.volumeM3],
    ] as Array<[string, unknown, unknown]>) {
      const nowEmpty = now === undefined || now === null || String(now).trim() === "" || Number(now) === 0;
      const hadValue = before !== undefined && before !== null && Number(before) > 0;
      if (nowEmpty && hadValue) {
        return `${label}原来是 ${before}，你清空了它 —— 但系统没有「把${label}清零」这个操作，` +
          `保存之后还是 ${before}。请填一个真实的${label}，或者把原来的数填回去。`;
      }
    }
  }

  /**
   * 应收金额（2026-08-31 排查条目1）：弹窗上标着「必填」却从来没检查过，
   * 员工空着点确认也能过，以为钱登记了其实是空的，对账才发现少收。
   * 规矩：必填、≥0（0 表示这单不加收）、最多两位小数（库里按两位存，
   * 多的位数会被抹掉，跟员工填的对不上 —— 跟上面重量/体积同一套道理）。
   */

  return null;
}

/**
 * 把可填可不填的数字字段转成请求体里的值：
 * 空着 / 0 / 非数字 → `undefined`（＝这个字段根本不发，后端不改它）。
 * ⚠️ 不许返回 0 —— 见上面那段注释。
 */
/**
 * 产品数量专用：空着 / 0 → 不发这个字段。
 * ⚠️ 单独一个函数是因为它在库里是 `Int`，而重量方数是 `Decimal` ——
 * 语义一样但列不一样，写在一起以后容易被人改混。
 */
export function optionalIntegerForReceive(raw: number | string | null | undefined): number | undefined {
  const n = optionalNumberForReceive(raw);
  if (n === undefined) return undefined;
  return Number.isInteger(n) ? n : undefined;
}

export function optionalNumberForReceive(raw: number | string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const t = String(raw).trim();
  if (t === "") return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}
