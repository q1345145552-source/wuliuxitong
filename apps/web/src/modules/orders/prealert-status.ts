/**
 * 预报单「审批状态」怎么说（修复第 1 轮，2026-10-08）。
 *
 * 客户「首页预报单表」和「预报单」页调的是 /client/prealerts?status=all，员工建的单、到货通知转出来的单（approved，
 * 包括还在「待入库」的）也会列进来。原来状态格写的是「不是已收货就一律已发货」—— 同一票货在运单详情、导出里是「已审核」，
 * 在预报单表里却是「已发货」，客户会以为货还没到仓。三处统一按这一份说。
 */
export const PREALERT_APPROVAL_ZH: Record<string, string> = {
  pending: "待审核",
  approved: "已审核",
  shipped: "已发货",
  received: "已收货",
};

/** 认不出的原样给（别吞成「已发货」），空的给 fallback */
export function prealertApprovalZh(status: string | null | undefined, fallback = "—"): string {
  if (!status) return fallback;
  return PREALERT_APPROVAL_ZH[status] ?? status;
}

/** 预报单表状态格的小标签：字和配色 */
export function prealertStatusTag(status: string | null | undefined): { label: string; color: string; bg: string } {
  const label = prealertApprovalZh(status);
  if (status === "received") return { label, color: "var(--c-green-3)", bg: "#dcfce7" };
  if (status === "shipped") return { label, color: "#1e3a8a", bg: "#EEF2FB" };
  if (status === "pending") return { label, color: "#92400e", bg: "#fef3c7" };
  return { label, color: "var(--t-strong)", bg: "var(--s-cool)" };
}
