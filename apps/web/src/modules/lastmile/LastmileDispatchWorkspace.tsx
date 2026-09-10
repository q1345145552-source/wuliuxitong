"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiBaseUrl, authHeaders, parseApiResponse, fetchWithSession as fetch } from "../../services/core-api";
import { openShipmentTrack } from "../shipment/ShipmentTrackModal";
import { createRequestGate } from "../shared/request-gate";
import { downloadLastmileCustomerWorkbook } from "./exportDispatchWorkbooks";
import type { LastmileOrderItem, LastmileShipmentOption, LastmileWdGroup } from "./types";
import {
  buildLastmileWdGroups,
  filterLastmileWdGroups,
  lastmileSummaryOf,
  summarizeLastmileMeta,
  type LastmileStatusFilter,
} from "./viewModel";

const WD_PAGE_SIZE = 20;

export type LastmileDispatchWorkspaceProps = {
  id?: string;
  visible?: boolean;
  showHeading?: boolean;
  surface?: "page" | "embedded";
  lmShipments: LastmileShipmentOption[];
  lmOrderList: LastmileOrderItem[];
  ordersLoading?: boolean;
  ordersError?: string;
  shipmentsLoading?: boolean;
  shipmentsError?: string;
  onToast: (message: string) => void;
  onReloadOrders: () => void | Promise<void>;
  onLoadShipments: () => void | Promise<void>;
};

const inputStyle = {
  border: "1px solid var(--line)",
  borderRadius: "var(--a3-radius)",
  background: "var(--white)",
} as const;

function addressLabel(order: LastmileOrderItem): string {
  return order.receiverAddress?.trim() || "收货地址未填写";
}

function displayCustomerName(clientId: string, clientName: string): string {
  return clientName && clientName !== clientId ? `${clientId} · ${clientName}` : clientId;
}

export default function LastmileDispatchWorkspace(props: LastmileDispatchWorkspaceProps) {
  const [activeView, setActiveView] = useState<"tasks" | "create">("tasks");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shipmentSearch, setShipmentSearch] = useState("");
  const [batchInput, setBatchInput] = useState("");
  const [batchMissing, setBatchMissing] = useState<string[]>([]);
  const [driverName, setDriverName] = useState("");
  const [licensePlate, setLicensePlate] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [appendTarget, setAppendTarget] = useState("");
  const [signTargetId, setSignTargetId] = useState("");
  /** 2026-09-01 竞态全扫：凭证弹窗带上是哪一票的单号，看图的人才知道自己在看谁的凭证 */
  const [previewImage, setPreviewImage] = useState<{ src: string; label: string } | null>(null);
  const [orderSearch, setOrderSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<LastmileStatusFilter>("all");
  const [busy, setBusy] = useState(false);
  const [exportingKey, setExportingKey] = useState("");
  const [page, setPage] = useState(1);
  const signFileRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);

  const allGroups = useMemo(() => buildLastmileWdGroups(props.lmOrderList), [props.lmOrderList]);
  const summary = useMemo(() => lastmileSummaryOf(allGroups), [allGroups]);
  const filteredGroups = useMemo(
    () => filterLastmileWdGroups(allGroups, orderSearch, statusFilter),
    [allGroups, orderSearch, statusFilter],
  );
  const totalPages = Math.max(1, Math.ceil(filteredGroups.length / WD_PAGE_SIZE));
  const pagedGroups = useMemo(
    () => filteredGroups.slice((page - 1) * WD_PAGE_SIZE, page * WD_PAGE_SIZE),
    [filteredGroups, page],
  );

  const filteredShipments = useMemo(() => {
    const query = shipmentSearch.trim().toLocaleLowerCase();
    if (!query) return props.lmShipments;
    return props.lmShipments.filter((shipment) => [
      shipment.trackingNo,
      shipment.clientId,
      shipment.itemName,
      shipment.receiverName,
      shipment.receiverPhone,
      shipment.receiverAddress,
    ].some((value) => String(value ?? "").toLocaleLowerCase().includes(query)));
  }, [props.lmShipments, shipmentSearch]);

  const customerIds = useMemo(
    () => [...new Set(props.lmShipments.map((shipment) => shipment.clientId).filter(Boolean))],
    [props.lmShipments],
  );

  useEffect(() => setPage(1), [orderSearch, statusFilter]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const resetCreateDraft = () => {
    setSelected(new Set());
    setShipmentSearch("");
    setBatchInput("");
    setBatchMissing([]);
    setDriverName("");
    setLicensePlate("");
    setPhoneNumber("");
    setDeliveryDate("");
  };

  const matchBatchInput = () => {
    const numbers = batchInput.split(/[,\s\n]+/).map((value) => value.trim()).filter(Boolean);
    if (numbers.length === 0) {
      setBatchMissing([]);
      return;
    }
    const wanted = new Set(numbers);
    const matchedNumbers = new Set<string>();
    const matchedIds = new Set<string>();
    for (const shipment of props.lmShipments) {
      if (wanted.has(shipment.trackingNo)) {
        matchedNumbers.add(shipment.trackingNo);
        matchedIds.add(shipment.id);
      }
    }
    setSelected((current) => new Set([...current, ...matchedIds]));
    setBatchMissing(numbers.filter((number) => !matchedNumbers.has(number)));
    setBatchInput(numbers.join(", "));
  };

  const submitDispatch = async () => {
    const shipmentIds = [...selected];
    if (shipmentIds.length === 0) {
      props.onToast("请先勾选运单");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${apiBaseUrl()}/admin/lastmile/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          shipmentIds,
          deliveryNo: appendTarget || undefined,
          driverName: appendTarget ? undefined : driverName.trim(),
          licensePlate: appendTarget ? undefined : licensePlate.trim(),
          phoneNumber: appendTarget ? undefined : phoneNumber.trim(),
          deliveryDate: appendTarget ? undefined : deliveryDate,
        }),
      });
      const result = await parseApiResponse<{ deliveryNo?: string; count: number }>(response);
      const deliveryNo = appendTarget || result.deliveryNo || "WD";
      props.onToast(appendTarget
        ? `已追加 ${result.count} 票到 ${deliveryNo}`
        : `${deliveryNo} 已创建（${result.count}票运单）`);
      resetCreateDraft();
      setAppendTarget("");
      setActiveView("tasks");
      await props.onReloadOrders();
    } catch (error) {
      props.onToast(error instanceof Error ? error.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const startAppend = (deliveryNo: string) => {
    resetCreateDraft();
    setAppendTarget(deliveryNo);
    setActiveView("create");
    requestAnimationFrame(() => workspaceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  /** 2026-09-01 竞态全扫：快速点两票「看凭证」，先点那票的图后到会盖掉后点那票的 ——
      领号验号，只让最后一次点击的凭证落地；报错也只认最后一次。 */
  const signImageGate = useRef(createRequestGate()).current;
  const openSignImage = async (order: LastmileOrderItem) => {
    const ticket = signImageGate.begin();
    const label = order.trackingNo || order.shipmentId;
    try {
      const response = await fetch(`${apiBaseUrl()}/admin/lastmile/sign-image?id=${encodeURIComponent(order.id)}`, {
        headers: authHeaders(),
      });
      const data = await parseApiResponse<{ signImageBase64?: string }>(response);
      if (!signImageGate.isCurrent(ticket)) return; // 用户已点了别票，旧图不许盖新图
      if (data.signImageBase64) setPreviewImage({ src: `data:image/jpeg;base64,${data.signImageBase64}`, label });
      else props.onToast(`运单 ${label} 没有签收凭证`);
    } catch (error) {
      if (!signImageGate.isCurrent(ticket)) return; // 旧请求的报错也不弹
      props.onToast(error instanceof Error ? error.message : `运单 ${label} 签收凭证加载失败`);
    }
  };

  const handleSign = (file: File) => {
    if (!signTargetId) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const signImageBase64 = String(reader.result ?? "").split(",")[1] || "";
      setBusy(true);
      try {
        const response = await fetch(`${apiBaseUrl()}/admin/lastmile/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ id: signTargetId, status: "SIGNED", signImageBase64 }),
        });
        await parseApiResponse(response);
        props.onToast("该票运单已签收");
        await props.onReloadOrders();
      } catch (error) {
        props.onToast(error instanceof Error ? error.message : "签收失败，请重试");
      } finally {
        setBusy(false);
        setSignTargetId("");
      }
    };
    reader.readAsDataURL(file);
  };

  const deleteOrder = async (order: LastmileOrderItem) => {
    if (!confirm(`确定从 ${order.deliveryNo} 删除运单 ${order.trackingNo || order.shipmentId}？`)) return;
    try {
      const response = await fetch(`${apiBaseUrl()}/admin/lastmile/orders?id=${encodeURIComponent(order.id)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      const result = await parseApiResponse<{ message?: string }>(response);
      props.onToast(result.message || "已从该 WD 删除这票运单");
      await props.onReloadOrders();
    } catch (error) {
      props.onToast(error instanceof Error ? error.message : "删除失败，请重试");
    }
  };

  const exportCustomer = async (deliveryNo: string, clientId: string) => {
    if (!clientId || clientId === "未标记客户") {
      props.onToast("这组运单没有可导出的客户");
      return;
    }
    const key = `${deliveryNo}:${clientId}`;
    setExportingKey(key);
    try {
      await downloadLastmileCustomerWorkbook(deliveryNo, clientId);
      props.onToast(`已导出 ${deliveryNo} · ${clientId} 客户派送签收单`);
    } catch (error) {
      props.onToast(error instanceof Error ? error.message : "客户派送单导出失败");
    } finally {
      setExportingKey("");
    }
  };

  if (props.visible === false) return null;

  return (
    <section
      ref={workspaceRef}
      id={props.id ?? "lastmile-dispatch-workspace"}
      className={`lastmile-workspace lastmile-workspace--${props.surface ?? "page"}`}
    >
      {props.showHeading !== false && (
        <header className="lastmile-page-heading">
          <div>
            <span className="lastmile-eyebrow">尾端运营</span>
            <h2>尾端派送</h2>
            <p>一张 WD 代表一辆车的一趟派送，可包含多个客户和多个收货地址。</p>
          </div>
          <button
            type="button"
            className="lastmile-button lastmile-button--secondary"
            style={{ background: "var(--white)" }}
            onClick={() => void Promise.all([props.onReloadOrders(), props.onLoadShipments()])}
          >
            刷新数据
          </button>
        </header>
      )}

      <div className="lastmile-summary" aria-label="派送任务统计">
        <div><strong>{summary.totalWd}</strong><span>WD 总数</span></div>
        <div><strong>{summary.activeWd}</strong><span>派送中</span></div>
        <div><strong>{summary.doneWd}</strong><span>已完成</span></div>
        <div><strong>{summary.pendingShipments}</strong><span>待签收运单</span></div>
      </div>

      <nav className="lastmile-tabs" aria-label="尾端派送功能">
        <button
          type="button"
          className={activeView === "tasks" ? "is-active" : ""}
          style={{ background: "var(--white)" }}
          onClick={() => setActiveView("tasks")}
        >
          派送任务 <span>{allGroups.length}</span>
        </button>
        <button
          type="button"
          className={activeView === "create" ? "is-active" : ""}
          style={{ background: "var(--white)" }}
          onClick={() => {
            if (appendTarget) resetCreateDraft();
            setAppendTarget("");
            setActiveView("create");
          }}
        >
          创建 WD {selected.size > 0 && <span>{selected.size}</span>}
        </button>
      </nav>

      {activeView === "create" ? (
        <div className="lastmile-create-panel">
          <div className="lastmile-panel-heading">
            <div>
              <span className="lastmile-step-index">1</span>
              <div>
                <h3>{appendTarget ? `追加到 ${appendTarget}` : "选择本趟要送的运单"}</h3>
                <p>{appendTarget ? "只影响这张 WD，司机和车辆信息自动沿用原派送单。" : "可按运单、唛头、品名或收货地址搜索，也可批量粘贴运单号。"}</p>
              </div>
            </div>
            {appendTarget && (
              <button
                type="button"
                className="lastmile-button lastmile-button--secondary"
                style={{ background: "var(--white)" }}
                onClick={() => { resetCreateDraft(); setAppendTarget(""); setActiveView("tasks"); }}
              >
                取消追加
              </button>
            )}
          </div>

          <div className="lastmile-create-grid">
            <div className="lastmile-shipment-picker">
              <label className="lastmile-field lastmile-field--wide">
                <span>批量粘贴运单号</span>
                <div className="lastmile-inline-field">
                  <textarea
                    rows={2}
                    value={batchInput}
                    onChange={(event) => setBatchInput(event.target.value)}
                    onBlur={matchBatchInput}
                    placeholder="用逗号、空格或换行分隔"
                    style={inputStyle}
                  />
                  <button type="button" className="lastmile-button lastmile-button--secondary" style={{ background: "var(--white)" }} onClick={matchBatchInput}>
                    匹配并勾选
                  </button>
                </div>
              </label>
              {batchMissing.length > 0 && (
                <div className="lastmile-alert lastmile-alert--error">
                  <strong>{batchMissing.length} 个运单号没找到，未加入：</strong>
                  <span>{batchMissing.join("、")}</span>
                </div>
              )}

              <label className="lastmile-field">
                <span>搜索可派送运单</span>
                <input
                  value={shipmentSearch}
                  onChange={(event) => setShipmentSearch(event.target.value)}
                  onFocus={() => void props.onLoadShipments()}
                  placeholder="运单号 / 唛头 / 品名 / 地址"
                  style={inputStyle}
                />
              </label>

              {customerIds.length > 0 && (
                <div className="lastmile-quick-clients" aria-label="按唛头快速选择">
                  {customerIds.map((clientId) => (
                    <button
                      type="button"
                      key={clientId}
                      style={{ background: "var(--white)" }}
                      className={shipmentSearch === clientId ? "is-active" : ""}
                      onClick={() => {
                        setShipmentSearch(clientId);
                        const clientShipmentIds = props.lmShipments
                          .filter((shipment) => shipment.clientId === clientId)
                          .map((shipment) => shipment.id);
                        setSelected((current) => new Set([...current, ...clientShipmentIds]));
                      }}
                    >
                      {clientId}
                    </button>
                  ))}
                </div>
              )}

              <div className="lastmile-picker-list">
                {props.shipmentsLoading && props.lmShipments.length === 0 ? (
                  <div className="lastmile-picker-state">正在加载可派送运单…</div>
                ) : props.shipmentsError && props.lmShipments.length === 0 ? (
                  <div className="lastmile-picker-state lastmile-picker-state--error">{props.shipmentsError}</div>
                ) : filteredShipments.length === 0 ? (
                  <div className="lastmile-picker-state">没有匹配的可派送运单</div>
                ) : filteredShipments.map((shipment) => (
                  <label key={shipment.id} className={`lastmile-shipment-option ${selected.has(shipment.id) ? "is-selected" : ""}`}>
                    <input
                      type="checkbox"
                      checked={selected.has(shipment.id)}
                      onChange={() => setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(shipment.id)) next.delete(shipment.id);
                        else next.add(shipment.id);
                        return next;
                      })}
                    />
                    <span className="lastmile-option-main">
                      <strong>{shipment.trackingNo}</strong>
                      {/* 多产品的品名拼起来可能很长，被省略号截掉时鼠标停上去能看全（2026-09-10） */}
                      <span title={`${shipment.clientId || "未标记客户"} · ${shipment.itemName || "未填品名"}`}>{shipment.clientId || "未标记客户"} · {shipment.itemName || "未填品名"}</span>
                      {shipment.receiverAddress && <small>{shipment.receiverAddress}</small>}
                    </span>
                    <b>{shipment.packageCount}件</b>
                  </label>
                ))}
              </div>
              <div className="lastmile-picker-footer">
                <span>当前列出 {filteredShipments.length} / {props.lmShipments.length} 票</span>
                <button type="button" style={{ background: "transparent" }} onClick={() => setSelected(new Set())} disabled={selected.size === 0}>清空已选</button>
              </div>
            </div>

            <aside className="lastmile-trip-form">
              <div className="lastmile-panel-heading lastmile-panel-heading--compact">
                <span className="lastmile-step-index">2</span>
                <div>
                  <h3>{appendTarget ? "确认追加" : "填写车辆信息"}</h3>
                  <p>{appendTarget ? "选好运单后直接追加，不重新填司机资料。" : "以下资料均可后补，但填写后客户可在派送轨迹中看到司机联系信息。"}</p>
                </div>
              </div>
              {!appendTarget && (
                <div className="lastmile-form-grid">
                  <label className="lastmile-field"><span>司机姓名 <em>选填</em></span><input value={driverName} onChange={(event) => setDriverName(event.target.value)} placeholder="例如：张三" style={inputStyle} /></label>
                  <label className="lastmile-field"><span>车牌号 <em>选填</em></span><input value={licensePlate} onChange={(event) => setLicensePlate(event.target.value)} placeholder="例如：กท-1234" style={inputStyle} /></label>
                  <label className="lastmile-field"><span>联系电话 <em>选填</em></span><input value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} placeholder="司机电话" style={inputStyle} /></label>
                  <label className="lastmile-field"><span>派送日期 <em>选填</em></span><input type="date" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} style={inputStyle} /></label>
                </div>
              )}
              <div className="lastmile-create-summary">
                <span>{appendTarget ? "将追加" : "本趟已选"}</span>
                <strong>{selected.size}</strong>
                <b>票运单</b>
              </div>
              <button
                type="button"
                className="lastmile-button lastmile-button--primary lastmile-submit"
                style={{ background: "var(--ink)" }}
                disabled={busy || selected.size === 0}
                onClick={() => void submitDispatch()}
              >
                {busy ? "处理中…" : appendTarget ? `追加到 ${appendTarget}` : "创建 WD 派送任务"}
              </button>
              <p className="lastmile-submit-note">提交后这些运单会立即进入「派送中」，且写入客户物流轨迹。</p>
            </aside>
          </div>
        </div>
      ) : (
        <div className="lastmile-task-panel">
          <div className="lastmile-task-toolbar">
            <label className="lastmile-search-field">
              <span className="lastmile-search-icon" aria-hidden="true">⌕</span>
              <input
                value={orderSearch}
                onChange={(event) => setOrderSearch(event.target.value)}
                placeholder="搜索 WD / 运单 / 客户 / 地址 / 司机…"
                style={inputStyle}
              />
            </label>
            <div className="lastmile-filter-buttons" aria-label="派送状态筛选">
              {([
                ["all", "全部"],
                ["active", "派送中"],
                ["done", "已完成"],
              ] as const).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={statusFilter === value ? "is-active" : ""}
                  style={{ background: "var(--white)" }}
                  onClick={() => setStatusFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="lastmile-button lastmile-button--secondary"
              style={{ background: "var(--white)" }}
              disabled={props.ordersLoading}
              onClick={() => void props.onReloadOrders()}
            >
              {props.ordersLoading ? "加载中…" : "刷新"}
            </button>
          </div>

          {props.ordersError && (
            <div className="lastmile-load-state lastmile-load-state--error">
              <div><strong>派送单加载失败</strong><span>{props.ordersError}</span></div>
              <button type="button" className="lastmile-button lastmile-button--secondary" style={{ background: "var(--white)" }} onClick={() => void props.onReloadOrders()}>重新加载</button>
            </div>
          )}

          {props.ordersError && allGroups.length === 0 ? null : props.ordersLoading && props.lmOrderList.length === 0 ? (
            <div className="lastmile-load-state"><strong>正在加载派送任务…</strong></div>
          ) : allGroups.length === 0 ? (
            <div className="lastmile-empty-state">
              <strong>还没有 WD 派送任务</strong>
              <span>先选择已进入泰国尾端阶段的运单，再创建第一张 WD。</span>
              <button type="button" className="lastmile-button lastmile-button--primary" style={{ background: "var(--ink)" }} onClick={() => setActiveView("create")}>创建 WD</button>
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="lastmile-empty-state">
              <strong>没有匹配的 WD</strong>
              <span>可清空搜索词或切换状态筛选。</span>
              <button type="button" className="lastmile-button lastmile-button--secondary" style={{ background: "var(--white)" }} onClick={() => { setOrderSearch(""); setStatusFilter("all"); }}>重置筛选</button>
            </div>
          ) : (
            <>
              <div className="lastmile-results-meta">共 {filteredGroups.length} 张 WD，当前显示第 {(page - 1) * WD_PAGE_SIZE + 1}–{Math.min(page * WD_PAGE_SIZE, filteredGroups.length)} 张</div>
              <div className="lastmile-wd-list">
                {pagedGroups.map((group) => (
                  <LastmileWdCard
                    key={group.deliveryNo}
                    group={group}
                    busy={busy}
                    exportingKey={exportingKey}
                    onAppend={startAppend}
                    onExport={exportCustomer}
                    onSign={(id) => { setSignTargetId(id); signFileRef.current?.click(); }}
                    onOpenSignImage={openSignImage}
                    onDelete={deleteOrder}
                  />
                ))}
              </div>
              {totalPages > 1 && (
                <div className="lastmile-pagination">
                  <button type="button" style={{ background: "var(--white)" }} disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
                  <span>{page} / {totalPages}</span>
                  <button type="button" style={{ background: "var(--white)" }} disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <input
        ref={signFileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) handleSign(file);
        }}
      />

      {previewImage && (
        <div className="lastmile-image-preview" role="dialog" aria-modal="true" aria-label={`签收凭证 ${previewImage.label}`} onClick={() => setPreviewImage(null)}>
          {/* 2026-09-01 竞态全扫：标题写明单号，防止「看错票」——图上没字时根本分不清是谁的凭证 */}
          <div
            onClick={(event) => event.stopPropagation()}
            style={{ position: "absolute", top: 18, left: 22, padding: "6px 12px", borderRadius: 8, background: "var(--white)", color: "var(--ink)", fontSize: 13, fontWeight: 600 }}
          >
            签收凭证 · {previewImage.label}
          </div>
          <button type="button" style={{ background: "var(--white)" }} onClick={() => setPreviewImage(null)}>关闭</button>
          <img src={previewImage.src} alt={`签收凭证 ${previewImage.label}`} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </section>
  );
}

type WdCardProps = {
  group: LastmileWdGroup;
  busy: boolean;
  exportingKey: string;
  onAppend: (deliveryNo: string) => void;
  onExport: (deliveryNo: string, clientId: string) => void | Promise<void>;
  onSign: (id: string) => void;
  /** 2026-09-01 竞态全扫：传整票订单不只传 id —— 弹窗标题要单号，响应落地要认主人 */
  onOpenSignImage: (order: LastmileOrderItem) => void | Promise<void>;
  onDelete: (order: LastmileOrderItem) => void | Promise<void>;
};

function LastmileWdCard(props: WdCardProps) {
  const { group } = props;
  const driver = summarizeLastmileMeta(group.orders.map((order) => order.driverName));
  const plate = summarizeLastmileMeta(group.orders.map((order) => order.licensePlate));
  const phone = summarizeLastmileMeta(group.orders.map((order) => order.phoneNumber));
  const date = summarizeLastmileMeta(group.orders.map((order) => order.deliveryDate));

  return (
    <article className={`lastmile-wd-card ${group.done ? "is-done" : "is-active"}`}>
      <header className="lastmile-wd-header">
        <div className="lastmile-wd-identity">
          <div>
            <strong>{group.deliveryNo}</strong>
            <span className={`lastmile-status-badge ${group.done ? "is-done" : "is-active"}`}>{group.done ? "派送完成" : "派送中"}</span>
          </div>
          <p>{group.customers.length} 个客户 · {group.addressCount} 个收货地址 · {group.total} 票运单</p>
        </div>
        <div className="lastmile-wd-progress">
          {/* 2026-08-25：去掉了下面那条进度条。旁边已经写着「3/5」，
              条子不提供任何新信息，而且是全圆角胶囊 —— 用户明确说过界面不要这类装饰。 */}
          <div><span>签收进度</span><strong>{group.signed}/{group.total}</strong></div>
        </div>
        {!group.done && (
          <button type="button" className="lastmile-button lastmile-button--secondary" style={{ background: "var(--white)" }} onClick={() => props.onAppend(group.deliveryNo)}>
            追加运单
          </button>
        )}
      </header>

      {/* 四个全空就整行不渲染 —— 一整行的空格子只会占地方。
          只要有一个填了，四个格子照常并排显示，列的顺序和宽度都不变。 */}
      {(driver.display || plate.display || phone.display || date.display) ? (
      <div className="lastmile-trip-meta">
        <div title={driver.full}><span>司机</span><strong>{driver.display}</strong></div>
        <div title={plate.full}><span>车牌</span><strong>{plate.display}</strong></div>
        <div title={phone.full}><span>电话</span><strong>{phone.display}</strong></div>
        <div title={date.full}><span>派送日期</span><strong>{date.display}</strong></div>
      </div>
      ) : null}

      <div className="lastmile-customer-list">
        {group.customers.map((customer) => {
          const exportKey = `${group.deliveryNo}:${customer.clientId}`;
          return (
            <section key={customer.key} className="lastmile-customer-group">
              <header>
                <div>
                  <strong>{displayCustomerName(customer.clientId, customer.clientName)}</strong>
                  <span>{customer.orders.length} 票 · {customer.addressCount} 个地址</span>
                </div>
                <button
                  type="button"
                  className="lastmile-button lastmile-button--export"
                  style={{ background: "var(--white)" }}
                  disabled={customer.clientId === "未标记客户" || props.exportingKey === exportKey}
                  onClick={() => void props.onExport(group.deliveryNo, customer.clientId)}
                >
                  {props.exportingKey === exportKey ? "导出中…" : "导出该客户派送单"}
                </button>
              </header>
              <div className="lastmile-stop-list">
                {customer.orders.map((order) => (
                  <div key={order.id} className="lastmile-stop-row">
                    <div className="lastmile-address-cell">
                      <strong>{order.receiverName || "收货人未填写"}{order.receiverPhone ? ` · ${order.receiverPhone}` : ""}</strong>
                      <span>{addressLabel(order)}</span>
                    </div>
                    <div className="lastmile-shipment-cell">
                      <strong>{order.trackingNo || order.shipmentId}</strong>
                      <span title={`${order.itemName || "品名未填写"}${order.packageCount != null ? ` · ${order.packageCount}件` : ""}`}>{order.itemName || "品名未填写"}{order.packageCount != null ? ` · ${order.packageCount}件` : ""}</span>
                    </div>
                    <div className="lastmile-row-status">
                      <span className={`lastmile-status-badge ${order.status === "SIGNED" ? "is-done" : "is-active"}`}>{order.status === "SIGNED" ? "已签收" : "派送中"}</span>
                      {order.status === "SIGNED" && order.hasSignImage && (
                        <button type="button" style={{ background: "transparent" }} onClick={() => void props.onOpenSignImage(order)}>看凭证</button>
                      )}
                    </div>
                    <div className="lastmile-row-actions">
                      {order.status !== "SIGNED" && (
                        <button type="button" disabled={props.busy} className="is-sign" style={{ background: "var(--white)" }} onClick={() => props.onSign(order.id)}>上传签收</button>
                      )}
                      <button type="button" disabled={!order.trackingNo} style={{ background: "var(--white)" }} onClick={() => order.trackingNo && openShipmentTrack(order.trackingNo)}>物流轨迹</button>
                      <button type="button" className="is-danger" style={{ background: "var(--white)" }} onClick={() => void props.onDelete(order)}>删除</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </article>
  );
}
