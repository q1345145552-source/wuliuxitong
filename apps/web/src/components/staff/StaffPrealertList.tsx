"use client";

import type { OrderItem, OrderProductImageItem } from "../../services/business-api";
import type { PrealertEditDraft } from "../../modules/staff/types";
import { buildPrealertDraft, formatMetric } from "../../modules/staff/utils";
import { formatCny } from "../../modules/billing/billing-utils";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import PrealertSearch from "../../modules/shipment/PrealertSearch";
import StaffProductImagesPanel from "./StaffProductImagesPanel";

/**
 * ⚠️ 这四个数字框的口径（2026-08-29 第十轮之后定的）：
 *
 * onChange 是 `Number(e.target.value || 0)` —— 清空就变 0。
 * 复核指出「前端没有保留『未填写』」，这是对的。
 * 但把 `PrealertEditDraft` 那四个字段改成 string 要动 40 多处引用，
 * 这个项目里我因为「顺手大改」引入新 bug 已经好几次了，**不值得**。
 *
 * 所以退一步，让**显示**和**提交**两边口径对齐：
 *   · 显示：值是 0 就渲染成**空框**（`draft.x ? String(draft.x) : ""`），
 *     员工看到的是「没填」，不是一个看着像真数据的 0
 *   · 提交：`optionalNumberForReceive` 把 0 当成「没填」，**根本不发这个字段**
 *     （后端语义是「没传 = 不改」）；箱数是必填的，0 会被 validateReceiveDraft
 *     当场拦住并说人话
 *
 * ⚠️ 别把这里改回 `String(draft.x)` —— 那样 0 会显示成 "0"，
 *    员工会以为重量真的是 0 公斤。
 */

/** 预报单搜索状态 */
export type PrealertSearchState = {
  keyword: string;
  warehouseId: string;
  itemName: string;
  domesticTrackingNo: string;
};

export type StaffPrealertListProps = {
  /** 是否可见 */
  visible: boolean;
  /** 全部预报单 */
  prealerts: OrderItem[];
  /** 过滤后的预报单 */
  filteredPrealerts: OrderItem[];
  /** 搜索状态 */
  prealertSearch: PrealertSearchState;
  /** 更新搜索状态 */
  onPrealertSearchChange: (key: string, val: string) => void;
  /** 折叠面板 */
  prealertPanelCollapsed: boolean;
  /** 切换折叠 */
  onToggleCollapse: () => void;
  /** 编辑草稿 */
  prealertEditDrafts: Record<string, PrealertEditDraft>;
  /** 更新编辑草稿 */
  setPrealertEditDrafts: (updater: (prev: Record<string, PrealertEditDraft>) => Record<string, PrealertEditDraft>) => void;
  /** 确认后的草稿 */
  prealertConfirmedDrafts: Record<string, PrealertEditDraft>;
  /** 正在编辑的预报单ID */
  editingPrealertId: string | null;
  /** 设置正在编辑的预报单 */
  setEditingPrealertId: (id: string | null) => void;
  /** 批次草稿 */
  prealertBatchDrafts: Record<string, string>;
  /** 更新批次草稿 */
  setPrealertBatchDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  /** 操作进行中 */
  loading: boolean;
  /** 仓库选项 */
  warehouseOptions: Array<{ id: string; label: string }>;
  /** 确认修改预报单 */
  onConfirmPrealertEdit: (id: string) => void;
  /** 打开审核弹窗 */
  onApprovePrealert: (item: OrderItem) => void;
  /** 上传产品图 */
  onUploadImage: (orderId: string, file: File) => void;
  /** 删除产品图 */
  onDeleteImage: (imageId: string) => void;
};

const prealertEditInputStyle = {
  border: "1px solid var(--l-strong)",
  borderRadius: 6,
  padding: "5px 8px",
  width: "100%",
  fontSize: 12,
  marginBottom: 4,
} as const;

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: 4 }}>
      <div style={{ fontSize: 10, color: "var(--t-strong)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 500, color: "var(--t-strong)" }} title={value}>
        {value.length > 18 ? `${value.slice(0, 18)}…` : value}
      </div>
    </div>
  );
}

export default function StaffPrealertList(props: StaffPrealertListProps) {
  if (!props.visible) return null;

  return (
    <section
      id="staff-prealert-review"
      style={{
        display: "block",
        border: "1px solid var(--l-soft)",
        borderLeft: "4px solid var(--l-strong)",
        borderRadius: 12,
        padding: 16,
        marginBottom: 18,
        background: "var(--white)",
        boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18, color: "var(--t-heading)" }}>预报单收货确认</h2>
        <button
          type="button"
          onClick={props.onToggleCollapse}
          style={{
            border: "1px solid var(--l-strong)",
            borderRadius: 8,
            padding: "6px 10px",
            color: "var(--t-strong)",
            background: "var(--white)",
            fontWeight: 600,
          }}
        >
          {props.prealertPanelCollapsed ? "展开" : "折叠"}
        </button>
        <PrealertSearch
          value={props.prealertSearch}
          onChange={props.onPrealertSearchChange}
          onSearch={() => {}}
          warehouseOptions={props.warehouseOptions}
          inputStyle={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" }}
        />
      </div>
      <>
        {props.prealerts.length === 0 ? (
          <EmptyStateCard title="暂无待收货预报单" description="客户端创建预报单后会在这里显示。" />
        ) : props.filteredPrealerts.length === 0 ? (
          <EmptyStateCard title="未找到匹配预报单" description="可调整客户名字、国内快递单号、仓库或运输方式筛选条件。" />
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {props.filteredPrealerts.map((item) => {
              const draft = props.prealertEditDrafts[item.id] ?? buildPrealertDraft(item);
              const isEditing = props.editingPrealertId === item.id;
              const confirmedDraft = props.prealertConfirmedDrafts[item.id] ?? buildPrealertDraft(item);
              const displayDraft = isEditing ? draft : confirmedDraft;
              return (
                <div key={item.id} style={{ border: "1px solid var(--l-soft)", borderRadius: 6, padding: 8, background: "var(--white)" }}>
                  <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4, color: "var(--t-strong)" }}>
                    <span style={{ fontFamily: "monospace" }}>{item.orderNo || item.id}</span> · {item.clientId ?? "-"} · {item.createdAt.slice(0, 10)}
                  </div>
                  {(item.products?.length ?? 0) > 1 && (
                    <div style={{ fontSize: 11, color: "var(--t-strong)", marginBottom: 6, background: "#fefce8", borderRadius: 4, padding: "3px 6px" }}>
                      {(item.products ?? []).map((p: any) => `${p.itemName}×${p.packageCount}箱`).join(" | ")}
                    </div>
                  )}
                  <div style={{ marginBottom: 6, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 4 }}>
                    {isEditing ? (
                      <>
                        <select value={draft.warehouseId} onChange={(e) => props.setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), warehouseId: e.target.value } }))} style={prealertEditInputStyle}>
                          <option value="">请选择仓库</option>
                          {props.warehouseOptions.map((w) => <option key={w.id} value={w.id}>仓库：{w.label}</option>)}
                        </select>
                        <input value={draft.itemName} onChange={(e) => props.setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), itemName: e.target.value } }))} placeholder="品名" style={prealertEditInputStyle} />
                        <input type="number" value={draft.packageCount ? String(draft.packageCount) : ""} onChange={(e) => props.setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), packageCount: Number(e.target.value || 0) } }))} placeholder="箱数/袋数" style={prealertEditInputStyle} />
                        <select value={draft.packageUnit} onChange={(e) => props.setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), packageUnit: e.target.value as "bag" | "box" } }))} style={prealertEditInputStyle}>
                          <option value="box">箱（box）</option>
                          <option value="bag">袋（bag）</option>
                        </select>
                        <input type="number" value={draft.productQuantity ? String(draft.productQuantity) : ""} onChange={(e) => props.setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), productQuantity: Number(e.target.value || 0) } }))} placeholder="产品数量" style={prealertEditInputStyle} />
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <input type="number" step="0.01" min="0.01" value={draft.weightKg ? String(draft.weightKg) : ""} onChange={(e) => props.setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), weightKg: Number(e.target.value || 0) } }))} placeholder="重量" style={{ ...prealertEditInputStyle, marginBottom: 0 }} />
                          <span style={{ color: "var(--t-strong)", fontSize: 13, minWidth: 26 }}>kg</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <input type="number" step="0.001" min="0.001" value={draft.volumeM3 ? String(draft.volumeM3) : ""} onChange={(e) => props.setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), volumeM3: Number(e.target.value || 0) } }))} placeholder="体积" style={{ ...prealertEditInputStyle, marginBottom: 0 }} />
                          <span style={{ color: "var(--t-strong)", fontSize: 13, minWidth: 30 }}>m3</span>
                        </div>
                        <input value={draft.domesticTrackingNo} onChange={(e) => props.setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), domesticTrackingNo: e.target.value } }))} placeholder="国内快递单号" style={prealertEditInputStyle} />
                        <select value={draft.transportMode} onChange={(e) => props.setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), transportMode: e.target.value as "sea" | "land" } }))} style={prealertEditInputStyle}>
                          <option value="sea">运输方式：海运</option>
                          <option value="land">运输方式：陆运</option>
                        </select>
                        <input type="date" value={draft.shipDate} onChange={(e) => props.setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), shipDate: e.target.value } }))} style={prealertEditInputStyle} />
                      </>
                    ) : (
                      <>
                        <InfoItem label="品名" value={displayDraft.itemName} />
                        <InfoItem label="仓库" value={props.warehouseOptions.find((w) => w.id === displayDraft.warehouseId)?.label ?? displayDraft.warehouseId ?? "-"} />
                        <InfoItem label="箱数/袋数" value={`${displayDraft.packageCount} ${displayDraft.packageUnit}`} />
                        <InfoItem label="产品数量" value={String(displayDraft.productQuantity)} />
                        <InfoItem label="重量" value={`${formatMetric(displayDraft.weightKg, 2)} kg`} />
                        <InfoItem label="体积" value={`${formatMetric(displayDraft.volumeM3, 3)} m3`} />
                        <InfoItem label="国内快递单号" value={displayDraft.domesticTrackingNo ?? "-"} />
                        <InfoItem label="运输方式" value={displayDraft.transportMode === "sea" ? "海运" : "陆运"} />
                        <InfoItem label="发货日期" value={displayDraft.shipDate} />
                      </>
                    )}
                  </div>
                  <StaffProductImagesPanel
                    orderId={item.id}
                    images={item.productImages ?? []}
                    canManage
                    busy={props.loading}
                    onSelectFile={(file) => props.onUploadImage(item.id, file)}
                    onDelete={props.onDeleteImage}
                  />
                  <input
                    value={props.prealertBatchDrafts[item.id] ?? ""}
                    onChange={(e) => props.setPrealertBatchDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    placeholder="柜号（可选，装柜时填写）"
                    style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "5px 8px", width: "100%", fontSize: 12, marginBottom: 4 }}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    {isEditing ? (
                      <>
                        <button type="button" disabled={props.loading} onClick={() => props.onConfirmPrealertEdit(item.id)} style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "var(--white)", background: "var(--t-strong)", fontWeight: 600 }}>确认修改</button>
                        <button type="button" disabled={props.loading} onClick={() => {
                          const sourceItem = props.prealerts.find((p) => p.id === item.id);
                          props.setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: props.prealertConfirmedDrafts[item.id] ?? (sourceItem ? buildPrealertDraft(sourceItem) : prev[item.id]) }));
                          props.setEditingPrealertId(null);
                        }} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 14px", color: "var(--t-strong)", background: "var(--white)", fontWeight: 600 }}>取消修改</button>
                      </>
                    ) : (
                      <button type="button" disabled={props.loading} onClick={() => {
                        const sourceItem = props.prealerts.find((p) => p.id === item.id);
                        props.setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: props.prealertConfirmedDrafts[item.id] ?? prev[item.id] ?? (sourceItem ? buildPrealertDraft(sourceItem) : buildPrealertDraft(item)) }));
                        props.setEditingPrealertId(item.id);
                      }} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 14px", color: "var(--t-strong)", background: "var(--white)", fontWeight: 600 }}>修改</button>
                    )}
                    <button type="button" disabled={props.loading} onClick={() => props.onApprovePrealert(item)} style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "var(--white)", background: "var(--t-strong)", fontWeight: 600 }}>确认收货</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </>
    </section>
  );
}
