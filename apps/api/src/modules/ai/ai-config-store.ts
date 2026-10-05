import type {
  AiKnowledgeItem,
  StatusLabelConfig,
} from "../../../../../packages/shared-types/entities";
import type { ShipmentStatus } from "../../../../../packages/shared-types/shipment-status";
import type { AiKnowledgeStore, StatusLabelStore } from "./ai-types";

// 2026-09-02 终审整改：这里是状态标签的唯一来源 —— prisma/seed.ts 已改为直接 import 本名单
// （手抄副本已删），改这里就是改 seed，两边不会再走散。
export const DEFAULT_STATUS_LABELS: StatusLabelConfig[] = [
  { status: "created", labelZh: "已创建" },
  // 2026-09-02 进流程的新状态（货到国内仓）
  { status: "inWarehouseCN", labelZh: "已入库" },
  // 2026-10-06 到货通知「转待入库」：货到了国内仓、资料还没补全
  { status: "pendingInbound", labelZh: "待入库" },
  { status: "holdLoading", labelZh: "暂缓柜" },
  { status: "loaded", labelZh: "已装柜" },
  { status: "customsInspectCn", labelZh: "国内海关查验" },
  { status: "inspectClearedCn", labelZh: "国内查验放行" },
  { status: "exportCleared", labelZh: "出口已放行" },
  { status: "delayDeparted", labelZh: "延迟开船" },
  { status: "etaUpdated", labelZh: "到港时间更新" },
  { status: "portClosed", labelZh: "港口封港暂停作业" },
  { status: "berthed", labelZh: "已靠泊" },
  { status: "departed", labelZh: "已开船" },
  { status: "delayInTransit", labelZh: "延迟运输" },
  { status: "arrivedPort", labelZh: "已到港" },
  { status: "customsInspectTh", labelZh: "泰国海关查验" },
  { status: "inspectClearedTh", labelZh: "泰国查验放行" },
  { status: "customsTH", labelZh: "清关中" },
  { status: "customsCleared", labelZh: "清关已放行" },
  { status: "unloading", labelZh: "正在卸柜" },
  { status: "inWarehouseTH", labelZh: "已到仓" },
  { status: "deliveryBooked", labelZh: "预约派送" },
  { status: "outForDelivery", labelZh: "派送中" },
  { status: "delivered", labelZh: "已签收" },
  // 2026-08-31：补上 2026-08-06 新增的 5 个陆运环节。之前 delayInTransit 漏配
  // 让客户看过英文状态名，这次陆运整批漏掉，客户问 AI 会看到「inVietnam」这种代码。
  // 中文名照抄前端唯一对照表（apps/web/src/modules/shipment/shipment-status.ts），一字不差。
  { status: "atPortCn", labelZh: "到达凭祥口岸" },
  { status: "inVietnam", labelZh: "过境越南" },
  { status: "laosCleared", labelZh: "老挝边境已放行" },
  { status: "borderDelay", labelZh: "口岸滞留" },
  { status: "customsInspect", labelZh: "海关查验" },
  { status: "exception", labelZh: "异常" },
  { status: "returned", labelZh: "已退回" },
  { status: "cancelled", labelZh: "已取消" },
];

export class InMemoryStatusLabelStore implements StatusLabelStore {
  private readonly labels = new Map<ShipmentStatus, string>(
    DEFAULT_STATUS_LABELS.map((item) => [item.status, item.labelZh]),
  );

  async list(): Promise<StatusLabelConfig[]> {
    return Array.from(this.labels.entries()).map(([status, labelZh]) => ({ status, labelZh }));
  }

  async getLabel(status: ShipmentStatus): Promise<string | undefined> {
    return this.labels.get(status);
  }

  async upsert(items: StatusLabelConfig[]): Promise<void> {
    items.forEach((item) => {
      this.labels.set(item.status, item.labelZh);
    });
  }

  async resetDefaults(): Promise<void> {
    this.labels.clear();
    DEFAULT_STATUS_LABELS.forEach((item) => {
      this.labels.set(item.status, item.labelZh);
    });
  }
}

export class InMemoryAiKnowledgeStore implements AiKnowledgeStore {
  private readonly items: AiKnowledgeItem[] = [];

  async list(companyId: string): Promise<AiKnowledgeItem[]> {
    return this.items.filter((item) => item.companyId === companyId);
  }

  async add(item: Omit<AiKnowledgeItem, "id" | "createdAt">): Promise<AiKnowledgeItem> {
    const created: AiKnowledgeItem = {
      ...item,
      id: `kn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    };
    this.items.unshift(created);
    return created;
  }

  async remove(companyId: string, id: string): Promise<boolean> {
    const index = this.items.findIndex((item) => item.companyId === companyId && item.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    return true;
  }
}
