"use client";

import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import { authHeaders, apiBaseUrl, apiRequest, parseApiResponse, fetchWithSession as fetch } from "../../services/core-api";

// ── Types ──

/** 管理员查到的一条「删过的记录」（后端 GET /admin/shipments/track/deleted-logs） */
interface DeletedLogItem {
  auditId: string;
  deletedBy: string;
  deletedByName: string;
  deletedAt: string;
  /** 已经放回轨迹（管理员恢复过，或整柜撤销时自动放回） */
  restored: boolean;
  /** 删之前的整条记录 */
  log: Record<string, unknown>;
}

interface TimelineItem {
  /**
   * 这条记录在数据库里的 id，删「写错的一条」时靠它定位。
   * 后端只发给员工和管理员，客户端拿到的是空字符串。
   */
  id?: string;
  canDelete?: boolean;
  /** 显示当前状态的最后一条：不给删，弹窗里提示去装柜管理撤销（2026-09-17）。客户端不下发 */
  isCurrentStatus?: boolean;
  /**
   * 为什么不能删（2026-09-17 推进账本）：currentStatus 当前状态最后一条 / containerPush 柜子推进改了状态的记录 /
   * lastmile 派送记录；能删是 null。只发给员工和管理员
   */
  deleteBlockedReason?: "currentStatus" | "containerPush" | "lastmile" | null;
  /** 该条记录来自哪张运单。父运单标签里会混入子运单的记录，用它区分是哪一件货 */
  trackingNo?: string;
  fromStatus: string;
  toStatus: string;
  remark: string;
  /** 「下一站【泰国边境】」。老轨迹没有这个字段，空着就不显示 */
  nextStop?: string;
  changedAt: string;
  /**
   * 操作人：只有超级管理员拿得到（2026-09-15），员工和客户的接口返回里没有这两个字段。
   * 所以是可选的 —— 别在别处当成必有去读。
   */
  operatorRole?: string;
  operatorName?: string;
}

interface ChildShipmentData {
  trackingNo: string;
  batchNo: string | null;
  itemName: string | null;
  packageCount: number | null;
  currentStatus: string;
  timeline: TimelineItem[];
}

interface TrackData {
  /** 看这个页面的人是什么角色，客户端要隐藏内部信息 */
  viewerRole?: "admin" | "staff" | "client" | "agent";
  trackingNo: string;
  itemName?: string;
  products?: Array<{ itemName: string; packageCount: number }>;
  currentStatus: string;
  /** 子单进度不一样时，最快的那批走到哪了（2026-09-16，后端下发） */
  partialAhead?: string;
  containers: Array<{
    containerNo?: string;
    containerStatus: string;
    containerStatusLabel?: string;
    loadingDate?: string | null;
    departureDate?: string | null;
    ata?: string | null;
    customsClearedAt?: string | null;
  }>;
  timeline: TimelineItem[];
  children?: ChildShipmentData[];
  lastmile?: {
    carrierName: string;
    driverName?: string | null;
    licensePlate?: string | null;
    phoneNumber?: string | null;
    signImageBase64?: string | null;
    status: string;
  } | null;
}

import { shipmentStatusZh } from "./shipment-status";

// ── Status config ──

const STATUS_CONFIG: Record<string, { zh: string; color: string; bg: string; icon: string }> = {
  created:        { zh: "已创建",     color: "var(--t-muted)", bg: "var(--s-sunken)", icon: "" },
  // 前半段（2026-08-06 起才写轨迹）：客户预报 → 货入国内仓
  // 2026-09-02 起 inWarehouseCN 是流程里的正式一步，中文「已入库」（文案走 shipment-status.ts）
  inwarehousecn:  { zh: "已入库", color: "#1e3a8a", bg: "#EEF2FB", icon: "" },
  receivedcn:     { zh: "国内仓已收货", color: "#1e3a8a", bg: "#EEF2FB", icon: "" },
  pickedup:       { zh: "已揽收",     color: "var(--t-muted)", bg: "var(--s-sunken)", icon: "" },
  loaded:         { zh: "已装柜",     color: "#1e3a8a", bg: "#EEF2FB", icon: "" },
  delaydeparted:  { zh: "延迟开船",   color: "#b45309", bg: "var(--c-amber-bg)", icon: "" },
  delay_departed: { zh: "延迟开船",   color: "#b45309", bg: "var(--c-amber-bg)", icon: "" },
  // 2026-08-13 新增的 8 个环节。查验/封港/暂缓/延误一类给琥珀色（提醒），
  // 放行/预约一类给绿色和蓝色（正常往前走）。中文一律走 shipment-status.ts 那份。
  holdloading:      { zh: "暂缓柜",       color: "#b45309", bg: "var(--c-amber-bg)", icon: "" },
  customsinspectcn: { zh: "国内海关查验", color: "#b45309", bg: "var(--c-amber-bg)", icon: "" },
  inspectclearedcn: { zh: "国内查验放行", color: "var(--c-green-dark)", bg: "#dcfce7", icon: "" },
  etaupdated:       { zh: "到港时间更新", color: "#b45309", bg: "var(--c-amber-bg)", icon: "" },
  portclosed:       { zh: "港口封港暂停作业", color: "#b45309", bg: "var(--c-amber-bg)", icon: "" },
  berthed:          { zh: "已靠泊",       color: "var(--c-blue-deep)", bg: "var(--c-blue-bg-2)", icon: "" },
  customsinspectth: { zh: "泰国海关查验", color: "#b45309", bg: "var(--c-amber-bg)", icon: "" },
  inspectclearedth: { zh: "泰国查验放行", color: "var(--c-green-dark)", bg: "#dcfce7", icon: "" },
  deliverybooked:   { zh: "预约派送",     color: "#1e3a8a", bg: "#EEF2FB", icon: "" },
  departed:       { zh: "已开船",     color: "var(--c-blue-deep)", bg: "var(--c-blue-bg-2)", icon: "" },
  delayintransit: { zh: "延迟运输",   color: "#b45309", bg: "var(--c-amber-bg)", icon: "" },
  delay_in_transit: { zh: "延迟运输", color: "#b45309", bg: "var(--c-amber-bg)", icon: "" },
  arrivedport:    { zh: "已到港",     color: "var(--c-green-deep)", bg: "var(--c-green-bg)", icon: "" },
  // 陆运专属环节（2026-08-06）。key 必须小写，statusCfg 是按 toLowerCase() 查的
  atportcn:       { zh: "到达凭祥口岸", color: "var(--c-blue-deep)", bg: "var(--c-blue-bg-2)", icon: "" },
  exportcleared:  { zh: "出口已放行", color: "var(--c-green-dark)", bg: "#dcfce7", icon: "" },
  invietnam:      { zh: "过境越南",   color: "var(--c-blue-deep)", bg: "var(--c-blue-bg-2)", icon: "" },
  laoscleared:    { zh: "老挝边境已放行", color: "var(--c-green-dark)", bg: "#dcfce7", icon: "" },
  borderdelay:    { zh: "口岸滞留",   color: "#b45309", bg: "var(--c-amber-bg)", icon: "" },
  customsinspect: { zh: "海关查验",   color: "#b45309", bg: "var(--c-amber-bg)", icon: "" },
  customsth:      { zh: "清关中",     color: "var(--c-amber-deep)", bg: "var(--c-amber-bg)", icon: "" },
  customscleared: { zh: "清关已放行", color: "var(--c-green-dark)", bg: "#dcfce7", icon: "" },
  unloading:      { zh: "正在卸柜",   color: "var(--c-blue-deep)", bg: "var(--c-blue-bg-2)", icon: "" },
  inwarehouseth:  { zh: "已到仓",     color: "#1e3a8a", bg: "#EEF2FB", icon: "" },
  outfordelivery: { zh: "派送中",     color: "#1e3a8a", bg: "#EEF2FB", icon: "" },
  delivered:      { zh: "派送完成",   color: "var(--c-green-3)", bg: "#f0fdf4", icon: "" },
  exception:      { zh: "异常",       color: "var(--c-red-2)", bg: "#fef2f2", icon: "" },
  returned:       { zh: "已退回",     color: "var(--c-red-dark)", bg: "var(--c-red-bg)", icon: "" },
  cancelled:      { zh: "已取消",     color: "var(--t-muted)", bg: "var(--s-sunken)", icon: "" },
  // 容器状态（旧日志兼容）
  intransit:      { zh: "运输中",     color: "var(--c-blue-deep)", bg: "var(--c-blue-bg-2)", icon: "" },
  customs:        { zh: "清关中",     color: "var(--c-amber-deep)", bg: "var(--c-amber-bg)", icon: "" },
  loading:        { zh: "装柜中",     color: "#1e3a8a", bg: "#EEF2FB", icon: "" },
  sealed:         { zh: "已封柜",     color: "#1e3a8a", bg: "#EEF2FB", icon: "" },
  arrived:        { zh: "已到港",     color: "var(--c-green-deep)", bg: "var(--c-green-bg)", icon: "" },
};

function statusCfg(s: string) {
  // 颜色还是查下面这张表，中文一律走 shipment-status.ts 那一份，
  // 免得两边文案漂移、或者查不到时把英文原样显示给客户（2026-08-07）。
  const cfg = STATUS_CONFIG[s.toLowerCase()];
  return {
    zh: shipmentStatusZh(s),
    color: cfg?.color ?? "var(--t-muted)",
    bg: cfg?.bg ?? "var(--s-sunken)",
    icon: cfg?.icon ?? "",
  };
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${min}`;
}

function formatFullTime(iso: string): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${month}月${day}日`;
}

// ── Components ──

function LoadingSkeleton() {
  return (
    <div style={{ padding: "32px 0" }}>
      {[1, 2, 3, 4].map((i) => (
        <div key={i} style={{ display: "flex", gap: 12, marginBottom: 20, paddingLeft: 28, position: "relative" }}>
          <div style={{ position: "absolute", left: 2, top: 0, bottom: -20, width: 2, background: "var(--l-soft)" }} />
          <div style={{ position: "absolute", left: -3, top: 2, width: 12, height: 12, borderRadius: "50%", background: "var(--l-soft)" }} />
          <div style={{ flex: 1 }}>
            <div style={{ height: 12, width: 80, background: "var(--l-soft)", borderRadius: 4, marginBottom: 6 }} />
            <div style={{ height: 14, width: "70%", background: "var(--s-sunken)", borderRadius: 4, marginBottom: 4 }} />
            <div style={{ height: 10, width: "40%", background: "var(--s-alt)", borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 员工/管理员看到的「这条为什么不能删」（2026-09-17 推进账本） */
const DELETE_BLOCKED_HINT: Record<"currentStatus" | "containerPush" | "lastmile", string> = {
  currentStatus: "当前状态，推错请到装柜管理撤销",
  containerPush: "推进记录，推错请到装柜管理撤销",
  lastmile: "派送记录，在尾端派送里处理",
};

/**
 * 一条轨迹记录。样式参考主流快递的物流详情：
 * 左侧圆点竖线，右侧「状态 + 时间」一行、备注一行，不用卡片和色块。
 * 列表是倒序渲染的（最新在最上），所以 index === 0 就是最新那条。
 */
function TimelineNode({ item, isLast, isChild, index, tabTrackingNo, hideOperator, canEdit, onDelete, deleting }: { item: TimelineItem; isLast: boolean; isChild?: boolean; index: number; total: number; tabTrackingNo?: string; hideOperator?: boolean; canEdit?: boolean; onDelete?: (item: TimelineItem) => void; deleting?: boolean }) {
  const toCfg = statusCfg(item.toStatus);
  const isLatest = index === 0;
  // 父运单标签下混合展示了各子单的记录，标出这条属于哪个子单
  const sourceLabel = item.trackingNo && item.trackingNo !== tabTrackingNo ? item.trackingNo : null;
  // 墨黑配色：不用彩色，最新一条黑色实心，历史节点浅灰描边
  const INK = "var(--t-heading)";
  const tickColor = isLatest ? "var(--white)" : "var(--t-faint)";
  const dot = isChild ? 20 : 22;
  // 备注跟状态说的是同一件事就不重复显示
  const showRemark = Boolean(item.remark && item.remark !== toCfg.zh);
  // 只有超级管理员显示操作人（2026-09-15，员工也不显示）；管理员也要真有名字才显示，不兜底成「员工/管理员」
  const showOperator = !hideOperator && Boolean(item.operatorName) && item.operatorRole !== "client";

  return (
    <div style={{ position: "relative", paddingLeft: dot + 16, paddingBottom: isLast ? 0 : 22 }}>
      {/* 竖线：连到下一条 */}
      {!isLast && (
        <div style={{
          position: "absolute",
          left: dot / 2 - 0.5,
          top: dot + 4,
          bottom: 0,
          width: 1,
          background: "var(--l-soft)",
        }} />
      )}

      {/* 圆点：最新一条黑色实心，其余白底浅灰描边。对勾用两条边框画，比字体的 ✓ 更细更规整 */}
      <div style={{
        position: "absolute",
        left: 0,
        top: 1,
        width: dot,
        height: dot,
        borderRadius: "50%",
        border: `1.5px solid ${isLatest ? INK : "var(--l-strong)"}`,
        background: isLatest ? INK : "var(--white)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
      }}>
        <span style={{
          display: "block",
          width: isChild ? 4 : 5,
          height: isChild ? 8 : 9,
          marginTop: -2,
          borderRight: `1.6px solid ${tickColor}`,
          borderBottom: `1.6px solid ${tickColor}`,
          transform: "rotate(45deg)",
        }} />
      </div>

      {/* 第一行：状态 + 时间 */}
      <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 10 }}>
        <span style={{
          fontSize: isChild ? 14 : 15,
          fontWeight: isLatest ? 700 : 500,
          color: isLatest ? "var(--t-heading)" : "var(--t-body)",
        }}>{toCfg.zh}</span>
        <span style={{ fontSize: isChild ? 12 : 13, color: "var(--t-faint)" }}>
          {formatTime(item.changedAt)}
        </span>
        {sourceLabel && (
          <span style={{ fontSize: 12, color: "var(--t-muted)" }}>{sourceLabel}</span>
        )}
        {/* 删掉写错的一条（员工/管理员）。客户端后端根本不下发 id，这里不会出现。
            显示当前状态的那条不给删：删除只删记录、不改状态（2026-09-17），状态推错了要去装柜管理撤销 */}
        {canEdit && item.deleteBlockedReason ? (
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--t-faint)" }}>{DELETE_BLOCKED_HINT[item.deleteBlockedReason]}</span>
        ) : canEdit && item.isCurrentStatus ? (
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--t-faint)" }}>{DELETE_BLOCKED_HINT.currentStatus}</span>
        ) : onDelete && item.id ? (
          <button
            type="button"
            disabled={deleting}
            onClick={() => onDelete(item)}
            style={{
              marginLeft: "auto",
              border: "1px solid var(--l-soft)",
              borderRadius: 6,
              padding: "2px 8px",
              background: "var(--white)",
              color: deleting ? "var(--t-faint)" : "var(--c-red-deep)",
              fontSize: 12,
              cursor: deleting ? "not-allowed" : "pointer",
            }}
          >
            {deleting ? "删除中…" : "删除"}
          </button>
        ) : null}
      </div>

      {/* 第二行：备注（跟状态重复就不显示）+ 操作人。
          操作人只给超级管理员显示 —— 员工和客户的接口里后端根本不下发，这里也不会兜底成「员工/管理员」 */}
      {showRemark || showOperator ? (
        <div style={{ marginTop: 4, fontSize: isChild ? 12 : 13, color: "var(--t-faint)", lineHeight: 1.6 }}>
          {showRemark ? item.remark : null}
          {showOperator ? (
            <span style={{ marginLeft: showRemark ? 8 : 0 }}>{item.operatorName}</span>
          ) : null}
        </div>
      ) : null}

      {/* 下一站（2026-08-06）。客户看得到货接下来去哪，比如「下一站【泰国边境】」。
          老轨迹这个字段是空的，就不显示这一行。 */}
      {item.nextStop ? (
        <div style={{ marginTop: 2, fontSize: isChild ? 12 : 13, color: "var(--t-muted)", lineHeight: 1.6 }}>
          下一站【{item.nextStop}】
        </div>
      ) : null}
    </div>
  );
}

function TrackContent({ data, onReload }: { data: TrackData; onReload?: () => void }) {
  const [activeTab, setActiveTab] = useState(0); // 0=父运单, 1+=子运单
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 管理员：这票货删过的记录（2026-09-17 推进账本，删之前后端存了底，能原样恢复）
  const [deletedLogs, setDeletedLogs] = useState<DeletedLogItem[] | null>(null);
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const isAdmin = data.viewerRole === "admin";

  const loadDeletedLogs = async () => {
    setDeletedLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl()}/admin/shipments/track/deleted-logs?trackingNo=${encodeURIComponent(data.trackingNo)}`, {
        method: "GET",
        headers: { ...authHeaders() },
      });
      const body = await parseApiResponse<{ items: DeletedLogItem[] }>(res);
      setDeletedLogs(body.items ?? []);
    } catch (e) {
      window.alert("查删过的记录失败：" + (e instanceof Error ? e.message : "请重试"));
    } finally {
      setDeletedLoading(false);
    }
  };

  const handleRestore = async (item: DeletedLogItem) => {
    if (restoringId) return;
    const ok = window.confirm(
      `把这一条放回物流轨迹吗？\n\n　${statusCfg(String(item.log.toStatus ?? "")).zh}　${formatTime(String(item.log.changedAt ?? ""))}\n\n` +
      `· 只是把记录放回去，运单状态不会变\n· 客户也会重新看到这一条`,
    );
    if (!ok) return;
    setRestoringId(item.auditId);
    try {
      await apiRequest(`${apiBaseUrl()}/admin/shipments/track/restore-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auditId: item.auditId }),
      });
      await loadDeletedLogs();
      onReload?.();
    } catch (e) {
      window.alert("恢复失败：" + (e instanceof Error ? e.message : "请重试"));
    } finally {
      setRestoringId(null);
    }
  };

  // 员工和管理员可以删掉写错的一条轨迹（客户不行，后端连 id 都不下发）。
  // 2026-09-17 起只删记录、不改运单状态；不能删的（当前状态最后一条 / 柜子推进记录 / 派送记录）后端标 deleteBlockedReason
  const canEditTimeline = data.viewerRole === "staff" || data.viewerRole === "admin";

  const handleDeleteLog = async (item: TimelineItem) => {
    if (!item.id || item.canDelete === false || deletingId) return;
    const label = statusCfg(item.toStatus).zh;
    const ok = window.confirm(
      `确定删掉这一条吗？\n\n　${label}　${formatTime(item.changedAt)}\n\n` +
      `删掉之后：\n` +
      `· 只是从物流轨迹里去掉这一条，客户也看不到了\n` +
      `· 运单状态不会变（状态推错了请到「装柜管理」点「撤销」）\n` +
      `· 删错了找管理员，管理员能在「删过的记录」里恢复`,
    );
    if (!ok) return;
    setDeletingId(item.id);
    try {
      await apiRequest(`${apiBaseUrl()}/staff/shipments/track/delete-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logId: item.id }),
      });
      onReload?.();
    } catch (e) {
      window.alert("删除失败：" + (e instanceof Error ? e.message : "请重试"));
    } finally {
      setDeletingId(null);
    }
  };
  const allTabs = [
    { trackingNo: data.trackingNo, currentStatus: data.currentStatus, partialAhead: data.partialAhead, timeline: data.timeline, packageCount: undefined as number | undefined },
    ...(data.children ?? []).map(c => ({ trackingNo: c.trackingNo, currentStatus: c.currentStatus, partialAhead: undefined as string | undefined, timeline: c.timeline, packageCount: c.packageCount })),
  ];
  const tab = allTabs[activeTab] ?? allTabs[0];
  const currentCfg = statusCfg(tab.currentStatus);

  return (
    <div>
      {/* Tab bar */}
      {allTabs.length > 1 && (
        <div style={{ display: "flex", gap: 0, marginBottom: 16, border: "1px solid var(--l-soft)", borderRadius: 10, overflow: "hidden" }}>
          {allTabs.map((t, i) => (
            <button
              key={i}
              onClick={() => setActiveTab(i)}
              style={{
                flex: 1,
                border: "none",
                padding: "8px 12px",
                fontSize: 12,
                fontWeight: activeTab === i ? 700 : 500,
                background: activeTab === i ? "var(--c-blue)" : "var(--white)",
                color: activeTab === i ? "var(--white)" : "var(--t-body)",
                cursor: "pointer",
                borderRight: i < allTabs.length - 1 ? "1px solid var(--l-soft)" : "none",
              }}
            >
              {i === 0 ? `${t.trackingNo}` : `${t.trackingNo}`}
            </button>
          ))}
        </div>
      )}

      {/* 装柜时间线（客户端看到日期但不含柜号） */}
      {data.containers && data.containers.length > 0 && data.containers.some(c => c.loadingDate || c.departureDate) ? (
        <div style={{ marginBottom: 14, fontSize: 13, color: "var(--t-muted)" }}>
          <div style={{ fontWeight: 600, color: "var(--t-body)", marginBottom: 4 }}>装柜时间</div>
          {data.containers.map((c, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              {c.loadingDate ? <div>装柜：{c.loadingDate.slice(0, 10)}</div> : null}
              {c.departureDate ? <div>开船：{c.departureDate.slice(0, 10)}</div> : null}
              {c.ata ? <div>到港：{c.ata.slice(0, 10)}</div> : null}
              {c.customsClearedAt ? <div>清关放行：{c.customsClearedAt.slice(0, 10)}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* 尾程派送 */}
      {data.lastmile ? (
        <div style={{ marginBottom: 14, fontSize: 13, color: "var(--t-muted)" }}>
          <div style={{ fontWeight: 600, color: "var(--t-body)", marginBottom: 4 }}>派送信息</div>
          {data.lastmile.driverName ? <div>司机：{data.lastmile.driverName}</div> : null}
          {data.lastmile.licensePlate ? <div>车牌：{data.lastmile.licensePlate}</div> : null}
          {data.lastmile.phoneNumber ? <div>电话：{data.lastmile.phoneNumber}</div> : null}
          <div>状态：{data.lastmile.status === "SIGNED" ? "已签收" : " 派送中"}</div>
          {data.lastmile.signImageBase64 ? (
            <div style={{ marginTop: 6 }}>
              <img
                src={data.lastmile.signImageBase64}
                alt="签收凭证"
                onClick={() => setZoomImage(data.lastmile!.signImageBase64!)}
                title="点击查看大图"
                style={{ maxWidth: 200, maxHeight: 200, borderRadius: 6, border: "1px solid var(--l-soft)", cursor: "zoom-in", display: "block" }}
              />
              <div style={{ fontSize: 12, color: "var(--t-faint)", marginTop: 3 }}>点击查看大图</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 产品信息 */}
      <div style={{ marginBottom: 14, fontSize: 13, color: "var(--t-muted)" }}>
        {activeTab === 0 ? (
          <>
            {data.products && data.products.length > 1 ? (
              data.products.map((p, i) => (
                <div key={i}>{p.itemName} ×{p.packageCount}箱</div>
              ))
            ) : (
              <span>品名：{data.itemName ?? "—"}</span>
            )}
            <div style={{ marginTop: 2 }}>分装：{data.children?.length ?? 0}个子单</div>
          </>
        ) : data.children?.[activeTab - 1] ? (
          <span>{data.children[activeTab - 1].itemName ?? "—"} ｜ {data.children[activeTab - 1].packageCount ?? "—"} 件{data.containers?.[0]?.containerNo && data.children[activeTab - 1].batchNo ? ` ｜ 柜号：${data.children[activeTab - 1].batchNo}` : ""}</span>
        ) : null}
      </div>

      {/* 当前状态：只留文字，不用渐变底、色块和光晕 */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 12, color: "var(--t-faint)", marginBottom: 3 }}>当前状态</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: "var(--t-heading)" }}>
          {currentCfg.zh}
          {/* 子单进度不一样时把话说全：主状态仍是最慢的那批（2026-09-16 拍板） */}
          {tab.partialAhead ? <span style={{ fontSize: 13, fontWeight: 500, color: "var(--t-muted)" }}>（部分{statusCfg(tab.partialAhead).zh}）</span> : null}
        </div>
        {activeTab === 0 && data.containers?.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--t-faint)", marginTop: 3 }}>
            {data.containers.map((c) => c.containerNo).filter(Boolean).join("  ｜  ") || null}
          </div>
        )}
      </div>

      {/* Timeline header */}
      {tab.timeline.length > 0 ? (
        <>
          <div style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            marginBottom: 14,
            paddingBottom: 8,
            borderBottom: "1px solid var(--s-sunken)",
          }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--t-heading)" }}>状态变更记录</span>
            <span style={{ fontSize: 12, color: "var(--t-faint)" }}>{tab.timeline.length} 条</span>
          </div>

          {/* Timeline: 最新在上 */}
          <div style={{ position: "relative" }}>
            {tab.timeline.slice().reverse().map((item, i) => (
              <TimelineNode
                key={i}
                item={item}
                isLast={i === tab.timeline.length - 1}
                index={i}
                total={tab.timeline.length}
                tabTrackingNo={tab.trackingNo}
                hideOperator={data.viewerRole !== "admin"}
                canEdit={canEditTimeline}
                onDelete={canEditTimeline && item.canDelete !== false ? handleDeleteLog : undefined}
                deleting={deletingId === item.id}
              />
            ))}
          </div>
        </>
      ) : null}

      {/* 管理员：删过的记录（2026-09-17 推进账本）。只列这票货（含子单）删过的，恢复只放回记录不改状态 */}
      {isAdmin ? (
        <div style={{ marginTop: 18, paddingTop: 10, borderTop: "1px solid var(--s-sunken)" }}>
          {deletedLogs === null ? (
            <button
              type="button"
              disabled={deletedLoading}
              onClick={loadDeletedLogs}
              style={{ border: "none", background: "none", padding: 0, fontSize: 12, color: "var(--t-muted)", cursor: deletedLoading ? "not-allowed" : "pointer", textDecoration: "underline" }}
            >
              {deletedLoading ? "查询中…" : "删过的记录"}
            </button>
          ) : (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t-heading)", marginBottom: 8 }}>
                删过的记录（{deletedLogs.length} 条）
              </div>
              {deletedLogs.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--t-faint)" }}>这票货没有删过记录</div>
              ) : deletedLogs.map((d) => (
                <div key={d.auditId} style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", fontSize: 12, padding: "4px 0", borderBottom: "1px dashed var(--l-soft)" }}>
                  <span style={{ color: "var(--t-body)" }}>{statusCfg(String(d.log.toStatus ?? "")).zh}</span>
                  <span style={{ color: "var(--t-faint)" }}>{formatTime(String(d.log.changedAt ?? ""))}</span>
                  {d.log.remark ? <span style={{ color: "var(--t-muted)" }}>{String(d.log.remark)}</span> : null}
                  <span style={{ color: "var(--t-faint)" }}>
                    {String(d.log.trackingNo ?? "")} · {d.deletedByName || "未知"} 删于 {formatTime(d.deletedAt)}
                  </span>
                  {d.restored ? (
                    <span style={{ marginLeft: "auto", color: "var(--t-faint)" }}>已恢复</span>
                  ) : (
                    <button
                      type="button"
                      disabled={restoringId === d.auditId}
                      onClick={() => handleRestore(d)}
                      style={{ marginLeft: "auto", border: "1px solid var(--l-soft)", borderRadius: 6, padding: "2px 8px", background: "var(--white)", fontSize: 12, cursor: "pointer" }}
                    >
                      {restoringId === d.auditId ? "恢复中…" : "恢复"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* 大图查看：点图片放大，点任意处关闭 */}
      {zoomImage ? (
        <div
          onClick={() => setZoomImage(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            cursor: "zoom-out",
          }}
        >
          <img src={zoomImage} alt="查看大图" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8 }} />
          <div style={{ position: "absolute", top: 16, right: 20, color: "var(--white)", fontSize: 28, lineHeight: 1 }}>×</div>
        </div>
      ) : null}
    </div>
  );
}

// ── Modal wrapper ──

export type ShipmentTrackTarget =
  | { trackingNo: string; shipmentId?: never }
  | { shipmentId: string; trackingNo?: never };

/**
 * 轨迹从哪个接口取（2026-09-16 代理账号）。不传就是原来的 /client/shipments/track，湘泰三端行为不变。
 * 代理工作台传 /agent/shipments/track —— agent 令牌打 /client/* 会被服务端统一闸 403。
 */
export interface ShipmentTrackOptions {
  endpoint?: "/client/shipments/track" | "/agent/shipments/track";
}

function ShipmentTrackModal({ target, onClose, endpoint = "/client/shipments/track" }: { target: ShipmentTrackTarget; onClose: () => void; endpoint?: ShipmentTrackOptions["endpoint"] }) {
  const { trackingNo, shipmentId } = target;
  const [data, setData] = useState<TrackData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    setData(null);
    const params = new URLSearchParams(
      trackingNo !== undefined ? { trackingNo } : { shipmentId: shipmentId! }
    );
    fetch(`${apiBaseUrl()}${endpoint}?${params.toString()}`, {
      headers: { ...authHeaders() },
    })
      .then(parseApiResponse)
      .then((data: any) => {
        if (!data || !data.trackingNo) {
          setError("未找到该运单");
          setData(null);
        } else {
          setData(data);
        }
        setLoading(false);
      })
      .catch((err: any) => {
        setError(err?.message || "加载失败，请重试");
        setData(null);
        setLoading(false);
      });
  }, [trackingNo, shipmentId, endpoint]);

  useEffect(() => { load(); }, [load]);

  return (
    <div
      className="track-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.45)",
        padding: 16,
      }}
    >
      <div style={{
        width: "100%",
        maxWidth: 600,
        maxHeight: "88vh",
        overflow: "auto",
        background: "var(--white)",
        borderRadius: 16,
        boxShadow: "0 24px 80px rgba(0,0,0,0.25)",
      }}>
        {/* Header */}
        <div style={{
          position: "sticky",
          top: 0,
          zIndex: 2,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "18px 22px",
          background: "var(--white)",
          borderBottom: "1px solid var(--l-soft)",
          borderRadius: "16px 16px 0 0",
        }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--t-heading)" }}>物流轨迹</h3>
            <div style={{ fontSize: 12, color: "var(--t-muted)", marginTop: 2, fontFamily: "monospace" }}>
              {data?.trackingNo || trackingNo || shipmentId}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: "1px solid var(--l-soft)",
              background: "var(--white)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
              color: "var(--t-muted)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--s-sunken)";
              e.currentTarget.style.color = "var(--t-heading)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--white)";
              e.currentTarget.style.color = "var(--t-muted)";
            }}
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: "18px 22px 22px" }}>
          {loading ? (
            <LoadingSkeleton />
          ) : error ? (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}></div>
              <div style={{ fontSize: 14, color: "var(--c-red-deep)", marginBottom: 8 }}>{error}</div>
              <button
                onClick={() => load()}
                style={{
                  border: "1px solid var(--l-strong)",
                  borderRadius: 8,
                  padding: "6px 16px",
                  background: "var(--white)",
                  cursor: "pointer",
                  fontSize: 13,
                  color: "var(--t-body)",
                }}
              >
                重试
              </button>
            </div>
          ) : !data ? (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{ fontSize: 14, color: "var(--t-muted)", marginBottom: 4 }}>暂无物流轨迹</div>
              <div style={{ fontSize: 12, color: "var(--t-faint)" }}>货物状态更新后将显示在这里</div>
            </div>
          ) : (
            <TrackContent data={data} onReload={load} />
          )}
        </div>
      </div>


    </div>
  );
}

// ── Public API ──

export function openShipmentTrack(target: ShipmentTrackTarget, options: ShipmentTrackOptions = {}) {
  // 移除旧弹窗
  const old = document.getElementById("track-modal-root");
  if (old) old.remove();

  const overlay = document.createElement("div");
  overlay.id = "track-modal-root";
  document.body.appendChild(overlay);

  try {
    const root = createRoot(overlay);
    root.render(
      <ShipmentTrackModal
        target={target}
        endpoint={options.endpoint}
        onClose={() => {
          root.unmount();
          overlay.remove();
        }}
      />,
    );
  } catch (e) {
    console.error("ShipmentTrackModal: failed to mount", e);
    const errRoot = createRoot(overlay);
    errRoot.render(
      <div
        style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}
        onClick={() => { errRoot.unmount(); overlay.remove(); }}
      >
        <div style={{ width: "100%", maxWidth: 500, background: "var(--white)", borderRadius: 12, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}></div>
          <div style={{ fontSize: 14, color: "var(--c-red-deep)" }}>加载失败，请刷新页面后重试</div>
        </div>
      </div>,
    );
  }
}
