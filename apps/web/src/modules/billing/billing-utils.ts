import type { OrderItem } from "../../services/business-api";
import type { ShippingPriceItem } from "../../services/business-api";
import { DEFAULT_SHIPPING_PRICES } from "../../../../../packages/shared-types/constants";

type TransportMode = "sea" | "land";

const { sea, land } = DEFAULT_SHIPPING_PRICES;
const DEFAULT_UNIT_PRICE: Record<TransportMode, number> = { sea, land };

function safeNumber(input: unknown): number | null {
  if (typeof input !== "number") return null;
  if (Number.isNaN(input)) return null;
  return input;
}

/**
 * 计算应收金额。
 * @param prices — 从 /client/shipping/prices 获取的价格表，没传就用默认价格
 * @param minVolumeMap — 低消配置（立方米），如 {"sea": 0.5, "land": 0.2}
 */
export function calcOrderAmountCny(
  order: OrderItem,
  prices?: Record<string, ShippingPriceItem>,
  minVolumeMap?: Record<string, number>,
): number | null {
  const transport = (order.transportMode ?? "").toLowerCase();
  const transportMode: TransportMode | null = transport === "sea" || transport === "land" ? transport : null;
  if (!transportMode) return null;

  const weightKg = safeNumber(order.weightKg) ?? 0;
  const volumeM3 = safeNumber(order.volumeM3) ?? 0;
  if (weightKg <= 0 && volumeM3 <= 0) return null;

  const convertedVolumeByWeight = weightKg / 500;
  let chargeVolume = Math.max(volumeM3, convertedVolumeByWeight);
  if (!Number.isFinite(chargeVolume) || chargeVolume <= 0) return null;

  // 查客户专属价格
  const key = `${transportMode}|normal`;
  const priceItem = prices?.[key];
  const unitPrice = priceItem?.unitPriceCny ?? DEFAULT_UNIT_PRICE[transportMode];

  // 低消
  const disableMin = priceItem?.disableMinVolume ?? false;
  if (!disableMin && minVolumeMap) {
    const minV = minVolumeMap[transportMode];
    if (minV && chargeVolume < minV) chargeVolume = minV;
  }

  const amount = chargeVolume * unitPrice;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Number(amount.toFixed(2));
}

export function formatCny(amount: number | null | undefined): string {
  if (typeof amount !== "number" || Number.isNaN(amount)) return "-";
  return `¥${amount.toFixed(2)}`;
}

