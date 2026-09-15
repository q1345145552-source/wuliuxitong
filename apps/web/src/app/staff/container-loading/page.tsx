"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Toast from "../../../modules/layout/Toast";
import { openShipmentTrack } from "../../../modules/shipment/ShipmentTrackModal";
import { createRequestGate } from "../../../modules/shared/request-gate";
import { shipmentStatusZh } from "../../../modules/shipment/shipment-status";
import { downloadContainerDispatchWorkbook } from "../../../modules/lastmile/exportDispatchWorkbooks";
import {
  fetchLoadingManifests,
  createLoadingManifest,
  fetchLoadingManifestDetail,
  sealLoadingManifest,
  addShipmentToManifest,
  removeShipmentFromManifest,
  fetchStaffShipments,
  deleteContainer,
  updateContainerStatus,
  undoContainerStatus,
  setManifestTransportMode,
  type LoadingManifestItem,
  type LoadingManifestDetail,
  type ShipmentItem,
} from "../../../services/business-api";

const STATUS_LABEL: Record<string, string> = {
  LOADING: "装柜中",
  SEALED: "已封柜",
  DELAY_DEPARTED: "延迟开船",
  // 2026-08-13 新增 8 个环节 + 出口已放行海运也走。跟后端 CONTAINER_STATUS_LABEL 一份口径。
  HOLD_LOADING: "暂缓柜",
  CUSTOMS_INSPECT_CN: "国内海关查验",
  INSPECT_CLEARED_CN: "国内查验放行",
  ETA_UPDATED: "到港时间更新",
  PORT_CLOSED: "港口封港暂停作业",
  BERTHED: "已靠泊",
  CUSTOMS_INSPECT_TH: "泰国海关查验",
  INSPECT_CLEARED_TH: "泰国查验放行",
  DELIVERY_BOOKED: "预约派送",
  IN_TRANSIT: "运输中",
  DELAY_IN_TRANSIT: "延迟运输",
  ARRIVED: "已到港",
  CUSTOMS: "清关中",
  CUSTOMS_CLEARED: "清关已放行",
  UNLOADING: "正在卸柜",
  IN_WAREHOUSE_TH: "已到仓",
  // 这两步由尾端派送推进，装柜页不能推，但筛选下拉里要能选，所以标签必须有
  // （2026-08-06 把筛选项改成从这张表生成后，漏了这两个会显示成英文代码）
  OUT_FOR_DELIVERY: "派送中",
  SIGNED: "已签收",
  // 陆运专属环节（2026-08-06）
  AT_PORT_CN: "到达凭祥口岸",
  EXPORT_CLEARED: "出口已放行",
  IN_VIETNAM: "过境越南",
  LAOS_CLEARED: "老挝边境已放行",
  BORDER_DELAY: "口岸滞留",
  CUSTOMS_INSPECT: "海关查验",
};

// 顺序必须与后端 containers/status-flow.ts 的 CONTAINER_STATUS_FLOW 一致
// （最后的 OUT_FOR_DELIVERY / SIGNED 不在这里 —— 那两步归尾端派送推，装柜页不能推）
const STATUS_FLOW = ["LOADING", "HOLD_LOADING", "SEALED", "CUSTOMS_INSPECT_CN", "INSPECT_CLEARED_CN", "EXPORT_CLEARED", "DELAY_DEPARTED", "ETA_UPDATED", "PORT_CLOSED", "BERTHED", "IN_TRANSIT", "DELAY_IN_TRANSIT", "ARRIVED", "CUSTOMS_INSPECT_TH", "INSPECT_CLEARED_TH", "CUSTOMS", "CUSTOMS_CLEARED", "UNLOADING", "IN_WAREHOUSE_TH", "DELIVERY_BOOKED"] as const;

/**
 * 陆运流程（2026-08-06）。陆运走陆路口岸，没有「开船」「到港」。
 * 顺序必须与后端 CONTAINER_STATUS_FLOW_LAND 一致，改一边必须改另一边。
 */
const STATUS_FLOW_LAND = ["LOADING", "SEALED", "CUSTOMS_INSPECT_CN", "INSPECT_CLEARED_CN", "AT_PORT_CN", "BORDER_DELAY", "EXPORT_CLEARED", "IN_VIETNAM", "CUSTOMS_INSPECT", "LAOS_CLEARED", "CUSTOMS", "CUSTOMS_CLEARED", "UNLOADING", "IN_WAREHOUSE_TH"] as const;

/**
 * 顶部「状态」筛选的可选项，**按运输方式分开**（2026-08-06 用户要求：
 * 「先选择是海运还是陆运，然后再去选择对应的状态，这柜是选的陆运，那么运输状态只会出现陆运的」）。
 * 比上面两条流程多了尾端的派送中/已签收 —— 那两个不是装柜页推进的，但可以拿来筛。
 */
const FILTER_STATUSES_SEA = ["LOADING", "HOLD_LOADING", "SEALED", "CUSTOMS_INSPECT_CN", "INSPECT_CLEARED_CN", "EXPORT_CLEARED", "DELAY_DEPARTED", "ETA_UPDATED", "PORT_CLOSED", "BERTHED", "IN_TRANSIT", "DELAY_IN_TRANSIT", "ARRIVED", "CUSTOMS_INSPECT_TH", "INSPECT_CLEARED_TH", "CUSTOMS", "CUSTOMS_CLEARED", "UNLOADING", "IN_WAREHOUSE_TH", "DELIVERY_BOOKED", "OUT_FOR_DELIVERY", "SIGNED"] as const;
const FILTER_STATUSES_LAND = ["LOADING", "SEALED", "CUSTOMS_INSPECT_CN", "INSPECT_CLEARED_CN", "AT_PORT_CN", "BORDER_DELAY", "EXPORT_CLEARED", "IN_VIETNAM", "CUSTOMS_INSPECT", "LAOS_CLEARED", "CUSTOMS", "CUSTOMS_CLEARED", "UNLOADING", "IN_WAREHOUSE_TH", "OUT_FOR_DELIVERY", "SIGNED"] as const;

/**
 * 每个状态默认的下一站，与后端 status-flow.ts 的两张表一致；员工可以改。
 *
 * ⚠️ 必须分海运陆运。「已封柜」两条流程都有，原来只有一张表、填的是陆运的走法，
 *    海运柜推到已封柜就被写成「广西凭祥出口」—— 海运不走凭祥口岸。
 */
const NEXT_STOP_DEFAULT_SEA: Record<string, string> = {
  SEALED: "装船开船",
  IN_TRANSIT: "泰国港口",
  ARRIVED: "泰国清关",
  CUSTOMS_CLEARED: "泰国仓库",
};

const NEXT_STOP_DEFAULT_LAND: Record<string, string> = {
  SEALED: "广西凭祥出口",
  AT_PORT_CN: "排队出关口",
  EXPORT_CLEARED: "过境越南",
  IN_VIETNAM: "老挝",
  LAOS_CLEARED: "泰国边境",
  BORDER_DELAY: "排队出关口",
  // 海关查验=越南口岸抽查，下一步是老挝；跟后端 status-flow.ts 同步改（2026-08-31）
  CUSTOMS_INSPECT: "老挝",
  CUSTOMS_CLEARED: "泰国仓库",
};

/** 和后端 nextStopOf 一个口径：陆运走陆运，其余（含没标运输方式的老柜子）走海运 */
const nextStopDefault = (status: string, transportMode: string | null | undefined): string =>
  (transportMode === "land" ? NEXT_STOP_DEFAULT_LAND : NEXT_STOP_DEFAULT_SEA)[status] ?? "";

/** 柜子的运输方式。null = 2026-08-05 之前建的老柜子，判不出来，等员工自己补 */
const MODE_ZH = (mode: string | null | undefined): string =>
  mode === "sea" ? "海运" : mode === "land" ? "陆运" : "未标注";

const WAREHOUSE_ZH: Record<string, string> = {
  wh_yiwu_01: "义乌仓",
  wh_guangzhou_01: "广州仓",
  wh_dongguan_01: "东莞仓",
  wh_shenzhen_01: "深圳仓",
};

/* 运单状态的中文对照原来这个文件自己抄了一份，直接按原样查表、不转小写，
   后端发的是 outForDelivery（驼峰），表里只有 outfordelivery（全小写）→ 查不到，
   页面上就漏出了英文。2026-08-10 改用三端唯一那份 shipmentStatusZh()：
   它查表前统一转小写，查不到也返回「未知状态」并在控制台报一条，不会再漏英文。 */

/* 柜子状态一律黑字，不用颜色区分（2026-08-10 用户定的：「不要颜色，就是黑色就行了」）。
   原来只有 4 个状态有颜色、其余没有，本来就不整齐，索性全去掉。 */
const STATUS_COLOR: Record<string, string> = {};

const inputStyle = { border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 12px", fontSize: 13, background: "var(--white)" } as const;

export default function StaffContainerLoadingPage() {
  const [query, setQuery] = useState("");
  const [searchTrackingNo, setSearchTrackingNo] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [modeFilter, setModeFilter] = useState("");
  const [list, setList] = useState<LoadingManifestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ warehouse: "wh_yiwu_01", transportMode: "sea", voyage: "", vesselName: "", containerNo: "" });
  const [creating, setCreating] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [exportingContainerId, setExportingContainerId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<LoadingManifestDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  /** 2026-09-02 复核整改：详情加载失败的提示。失败时旧详情已被清空，详情区靠它显示「加载失败 + 点击重试」 */
  const [detailError, setDetailError] = useState("");
  const [adding, setAdding] = useState(false);
  const [statusRemark, setStatusRemark] = useState("");
  const [statusDate, setStatusDate] = useState("");
  const [targetStatus, setTargetStatus] = useState("");
  /** 下一站（2026-08-06）：选目标状态时自动填默认值，员工可改 */
  const [nextStop, setNextStop] = useState("");

  /**
   * 换柜子时把这一排推进用的输入清空。
   *
   * ⚠️ 2026-08-10 实测出来的坑：原来不清空。在**陆运**柜上选了「已封柜」，
   * 下一站会自动填「广西凭祥出口」；这时点到另一个**海运**柜，状态和下一站
   * 原样留在框里，直接点「确认推进」就把陆运的地名写进海运柜的客户轨迹了。
   * 光把默认值按运输方式拆开挡不住这条路 —— 那次根本没重新选状态。
   */
  useEffect(() => {
    setTargetStatus("");
    setNextStop("");
    setStatusRemark("");
    setStatusDate("");
  }, [selectedId]);
    
  // 运单列表搜索
  const [allShipments, setAllShipments] = useState<ShipmentItem[]>([]);
  const [shipSearch, setShipSearch] = useState({ trackingNo: "", clientId: "", transportMode: "" });
  const [selectedShipments, setSelectedShipments] = useState<Record<string, number>>({});
  const [bulkPieceDialog, setBulkPieceDialog] = useState<string | null>(null);
  const [bulkPieceCount, setBulkPieceCount] = useState("");
  const [unloadDialog, setUnloadDialog] = useState<{itemId: string; loadedPieces: number} | null>(null);
  const [unloadCount, setUnloadCount] = useState("");
  // 已装柜运单映射：shipmentId → container manifestNo
  const [loadedShipments, setLoadedShipments] = useState<Record<string, string>>({});

  const loadShipmentList = async () => {
    const [shipments, manifests] = await Promise.all([
      fetchStaffShipments(),
      fetchLoadingManifests({ status: "ALL" }),
    ]);
    setAllShipments(shipments);
    const mapping: Record<string, string> = {};
    for (const m of manifests) {
      try {
        const d = await fetchLoadingManifestDetail(m.id);
        d.bills.forEach((b) => { mapping[b.shipmentId] = m.manifestNo; });
      } catch (e) { console.error(e); }
    }
    setLoadedShipments(mapping);
  };

  // 加载运单列表 + 已装柜信息
  useEffect(() => {
    loadShipmentList().catch(() => {});
  }, []);

  // 筛选运单
  const filteredShipments = useMemo(() => {
    return allShipments
      .filter((s) => {
        if (s.parentTrackingNo) return false;
        if (shipSearch.trackingNo && !(s.trackingNo ?? "").toLowerCase().includes(shipSearch.trackingNo.toLowerCase())) return false;
        if (shipSearch.clientId && !(s.clientId ?? "").toLowerCase().includes(shipSearch.clientId.toLowerCase())) return false;
        if (shipSearch.transportMode && s.transportMode !== shipSearch.transportMode) return false;
        return true;
      })
      .sort((a, b) => {
        const an = (a.trackingNo ?? "").replace(/\D/g, "");
        const bn = (b.trackingNo ?? "").replace(/\D/g, "");
        return (Number(bn) || 0) - (Number(an) || 0);
      });
  }, [allShipments, shipSearch]);

  // 已在本柜中的运单 ID 集合
  const existingShipmentIds = useMemo(() => {
    const set = new Set<string>();
    if (detail) detail.bills.forEach((b) => set.add(b.shipmentId));
    return set;
  }, [detail]);

  /** 2026-09-01 竞态全扫：柜子搜索连发两次（A 条件、B 条件），A 的响应后到会把
      B 条件的结果盖回 A 的——领号验号，数据、报错、loading 三个分支只认最新请求。 */
  const listGate = useRef(createRequestGate()).current;
  const loadList = useCallback(async () => {
    const ticket = listGate.begin();
    setLoading(true);
    setError("");
    try {
      const items = await fetchLoadingManifests({ query: query.trim(), trackingNo: searchTrackingNo.trim(), status: statusFilter, transportMode: modeFilter });
      if (!listGate.isCurrent(ticket)) return; // 旧条件的响应后到，丢弃
      setList(items);
      if (!selectedId && items.length > 0) selectManifest(items[0].id); // 2026-09-02 终审整改：走统一入口，同步认主人
    } catch (e) {
      if (!listGate.isCurrent(ticket)) return; // 旧请求的报错不许安到新请求头上
      setError(e instanceof Error ? e.message : "加载失败");
      setList([]);
    } finally {
      if (listGate.isCurrent(ticket)) setLoading(false); // 旧请求不许掐掉新请求的加载态
    }
  }, [query, searchTrackingNo, statusFilter, modeFilter, selectedId, listGate]);

  useEffect(() => { void loadList(); }, []);

  /** 2026-09-01 竞态全扫：详情要「认主人」。连点柜 A、柜 B，A 的详情后到会顶掉 B 的。
      响应落地时核对「当前选中的柜子」还是不是出发时那个。每次渲染同步一次最新值。 */
  const selectedIdRef = useRef("");
  selectedIdRef.current = selectedId;

  /** 2026-09-02 终审整改：换柜必须在用户点击处**同步**赋值 ref——上面那句渲染期赋值
      要等重渲染才跑，点击到重渲染之间的间隙里，旧柜的晚响应核对的还是旧值，会照样落地
      盖到错的柜子上。渲染处那句保留作兜底。所有改选中柜子的入口一律走这里。 */
  const selectManifest = (id: string) => {
    // 2026-09-02 复核整改：重复点当前柜子不清详情不挂加载态——selectedId 没变，
    // 下面的 useEffect 不会重发请求，挂了加载态就永远下不来；但上次加载失败时点它等于重试
    if (id && id === selectedId && id === selectedIdRef.current) {
      if (detailError) void loadDetail(id);
      return;
    }
    selectedIdRef.current = id; // 点击处同步认主人，晚到的旧响应立刻失效
    // 2026-09-02 复核整改：切柜当场清空旧 detail——绝不让 A 的详情挂在屏幕上冒充 B。
    // 加载期间显示加载态，失败走「加载失败 + 点击重试」，两条路都不留旧详情。
    setDetail(null);
    setDetailError("");
    if (id) setLoadingDetail(true); // 点击到 useEffect 发请求之间的间隙也显示加载态，不闪「请选择」
    setSelectedId(id);
  };

  /** 2026-09-02 三审整改：详情自己的门闩——同一柜子的新旧两次刷新只认最新一票，
      旧票不许提前掐掉新票的加载态（照 client/consolidation 的写法，一份口径）。 */
  const detailGate = useRef(createRequestGate()).current;

  const loadDetail = useCallback(async (id: string) => {
    // 2026-09-02 三审整改（Codex 点名）：入口先认主人——柜 A 的操作回调 await 期间用户切到柜 B，
    // 回调醒来还会拿 A 的 id 来刷新。过期的刷新连号都不该领：不是当前选中柜就整个 return，
    // 不开 loading、不领号，旧上下文的刷新对新上下文零影响。
    // （修前的病：这条路照样开了 loading、领了号，响应在下面被认主人丢弃，
    //   finally 又因「主人不符」拒收 loading——柜 B 早已加载完、再没人来收，「加载中…」永远挂着。）
    if (!id || selectedIdRef.current !== id) return;
    const ticket = detailGate.begin(); // 认完主人才领号
    setStatusRemark("");
    setDetailError(""); // 2026-09-02 复核整改：新一轮加载出发，先清上一轮的失败提示
    setLoadingDetail(true);
    try {
      const d = await fetchLoadingManifestDetail(id);
      if (!detailGate.isCurrent(ticket) || selectedIdRef.current !== id) return; // 号作废或用户已点到别的柜子，A 的详情不落地
      setDetail(d);
    } catch (e) {
      if (!detailGate.isCurrent(ticket) || selectedIdRef.current !== id) return; // 旧柜子的报错也不弹
      // 2026-09-02 复核整改：加载失败绝不留上一个柜的详情冒充当前柜——
      // 清空详情，详情区显示「加载失败 + 点击重试」
      setDetail(null);
      setDetailError(e instanceof Error ? e.message : "详情加载失败");
    } finally {
      // 2026-09-02 三审整改：finally 只按票号收 loading，不再核对主人——
      // 被作废的旧票在此不碰 loading（不许掐掉新请求的加载态）；最新一票收尾必须把 loading 收掉，
      // 哪怕主人刚换（比如删柜后清空选中、再没有新请求来收），新主人的请求自己会再置 true。
      if (detailGate.isCurrent(ticket)) setLoadingDetail(false);
    }
  }, [detailGate]);

  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [selectedId, loadDetail]);

  /** 2026-09-02 复核整改：所有会写库的操作（加运单/卸运单/封柜/推进状态/撤销/删柜/改运输方式）
      动手前核对「当前详情的柜 id」===「即将操作的柜 id」。对不上说明屏幕上的详情和选中柜
      不是同一个柜子（详情还没加载完、或加载失败被清空），拒绝操作并让员工重新打开，
      绝不「看着 A、操作 B」。照集货页 guardDetailOwner 一个口径。 */
  const guardDetailOwner = (id: string): boolean => {
    if (!detail || detail.id !== id) {
      setToast("刚切换过柜子，屏幕上的详情和当前柜对不上，请重新打开柜子再操作");
      return false;
    }
    return true;
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await createLoadingManifest({
        warehouse: createForm.warehouse,
        transportMode: createForm.transportMode,
        containerNo: createForm.containerNo,
        carrierInfo: [createForm.voyage, createForm.vesselName].filter(Boolean).join(" / ") || undefined,
      });
      setToast(`装柜任务已创建: ${result.manifestNo}`);
      setShowCreate(false);
      setCreateForm({ warehouse: "wh_yiwu_01", transportMode: "sea", voyage: "", vesselName: "", containerNo: "" });
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const handlePushStatus = async (toStatus: string) => {
    if (!selectedId || !detail) return;
    // 2026-09-01 竞态全扫：刚点了别的柜子、详情还没跟上时，别拿 B 的 id 配 A 的详情去推状态
    // （2026-09-02 复核整改：统一走 guardDetailOwner）
    if (!guardDetailOwner(selectedId)) return;
    try {
      const result = await updateContainerStatus({ id: selectedId, toStatus, remark: statusRemark.trim() || undefined, date: statusDate || undefined, nextStop: nextStop.trim() || undefined });
      setStatusRemark("");
      setStatusDate("");
      setNextStop("");
      setToast(`柜子「${result.containerNo}」已推进至 ${STATUS_LABEL[toStatus] ?? toStatus}（影响 ${result.affectedShipmentCount} 个运单）`);
      await loadList();
      await loadDetail(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "状态更新失败");
    }
  };

  /** 推错了：整柜退回上一步，柜里每张运单那一批轨迹一起删掉 */
  const handleUndoStatus = async () => {
    if (!selectedId || !detail || undoing) return;
    // 2026-09-01 竞态全扫：确认弹窗里的状态名来自 detail，撤销动的却是 selectedId ——
    // 详情还没跟上选中柜时两者不是同一个柜子，先拦下（2026-09-02 复核整改：统一走 guardDetailOwner）
    if (!guardDetailOwner(selectedId)) return;
    const nowLabel = STATUS_LABEL[detail.status] ?? detail.status;
    const ok = window.confirm(
      `确定撤销这个柜子的「${nowLabel}」吗？\n\n` +
      `· 柜子退回上一个状态\n` +
      `· 柜里每张运单的这条轨迹都会删掉，客户看不到了\n` +
      `· 每张运单的当前状态退回到它自己上一条轨迹\n` +
      `· 撤了就找不回来了`,
    );
    if (!ok) return;
    setUndoing(true);
    try {
      const result = await undoContainerStatus(selectedId);
      setToast(
        `已撤销「${STATUS_LABEL[result.undoneStatus] ?? result.undoneStatus}」，` +
        `柜子退回「${STATUS_LABEL[result.currentStatus] ?? result.currentStatus}」` +
        `（${result.affectedShipmentCount} 个运单，删掉 ${result.deletedLogs} 条轨迹）`,
      );
      await loadList();
      await loadDetail(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "撤销失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      await loadList();
      await loadDetail(selectedId);
    } finally {
      setUndoing(false);
    }
  };

  const handleSeal = async () => {
    if (!selectedId) return;
    // 2026-09-02 复核整改：封柜写库，先核对屏幕上的详情就是要封的这个柜
    if (!guardDetailOwner(selectedId)) return;
    try {
      await sealLoadingManifest(selectedId);
      setToast("封柜成功");
      await loadList();
      await loadDetail(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "封柜失败");
    }
  };

  const handleDelete = async () => {
    if (!selectedId || !detail) return;
    // 2026-09-01 竞态全扫：确认弹窗里的柜号来自 detail，删的却是 selectedId ——
    // 不核对的话可能「看着 A 的柜号，删了 B 的柜」（2026-09-02 复核整改：统一走 guardDetailOwner）
    if (!guardDetailOwner(selectedId)) return;
    if (!confirm(`确定删除柜子 ${detail.manifestNo}？\n\n此操作不可撤销。`)) return;
    try {
      await deleteContainer(selectedId);
      setToast("柜子已删除");
      selectManifest(""); // 2026-09-02 终审整改：走统一入口，同步认主人
      setDetail(null);
      await loadList();
      await loadShipmentList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      await loadList();
      await loadShipmentList();
    }
  };

  const handleExportContainer = async () => {
    if (!detail || exportingContainerId) return;
    setExportingContainerId(detail.id);
    try {
      await downloadContainerDispatchWorkbook(detail.id);
      setToast(`柜子 ${detail.manifestNo} 的整柜拆柜派送清单已导出`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "整柜导出失败");
    } finally {
      setExportingContainerId("");
    }
  };

  const handleBulkAdd = async () => {
    const entries = Object.entries(selectedShipments);
    if (!selectedId || entries.length === 0) return;
    // 2026-09-02 复核整改：勾选是照着屏幕上的详情（「已在本柜」标记）勾的，装的却是 selectedId ——
    // 对不上就会把运单装进另一个柜
    if (!guardDetailOwner(selectedId)) return;
    setAdding(true);
    let success = 0;
    const errors: string[] = [];
    // 运输方式对不上的只提醒不拦（后端也不拦），线上真实存在海陆混装的柜
    const modeWarnings: string[] = [];
    for (const [trackingNo, pieceCount] of entries) {
      if (!trackingNo) { errors.push("空运单号"); continue; }
      try {
        const r = await addShipmentToManifest(selectedId, trackingNo, pieceCount > 0 ? pieceCount : undefined);
        if (r.warning) modeWarnings.push(`${trackingNo}（${r.warning}）`);
        success++;
      } catch (e: any) {
        errors.push(`${trackingNo}: ${e.message ?? "失败"}`);
      }
    }
    setToast(
      `成功添加 ${success} 个运单到装柜` +
      (errors.length > 0 ? `，失败 ${errors.length} 个：${errors.join("；")}` : "") +
      (modeWarnings.length > 0 ? `⚠️ 运输方式对不上：${modeWarnings.join("；")}（已装进去，如需调整请卸柜）` : ""),
    );
    setSelectedShipments({});
    await loadDetail(selectedId);
    await loadShipmentList();
    setAdding(false);
  };

  const handleRemoveShipment = async (itemId: string, pieceCount?: number) => {
    if (!selectedId) return;
    // 2026-09-02 复核整改：itemId 来自屏幕上的详情，卸柜请求发的柜 id 却是 selectedId ——
    // 两者不是同一个柜时会去错的柜里卸，先拦下
    if (!guardDetailOwner(selectedId)) return;
    try {
      await removeShipmentFromManifest(selectedId, itemId, pieceCount);
      setToast("运单已从装柜卸下");
      await loadDetail(selectedId);
      await loadShipmentList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "卸柜失败");
    }
  };



  return (
    <>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#14171D", margin: "0 0 16px" }}>装柜管理</h1>

      {/* 搜索 & 新建 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索柜号…" style={{ ...inputStyle, minWidth: 150 }} />
        <input value={searchTrackingNo} onChange={(e) => setSearchTrackingNo(e.target.value)} placeholder="搜索单号…" style={{ ...inputStyle, minWidth: 150 }} />
        {/* 先选运输方式，状态下拉再跟着变 —— 海运陆运的状态不放在一起。
            「未标注」是给老柜子补运输方式用的：2026-08-05 加这个功能时，
            有 5 个海陆混装柜和 4 个空柜判不出来，留了空等员工自己点。 */}
        <select
          value={modeFilter}
          onChange={(e) => {
            setModeFilter(e.target.value);
            // 换了运输方式，原来选的状态可能压根不属于新流程，重置掉免得筛出空列表
            setStatusFilter("ALL");
          }}
          style={inputStyle}
        >
          <option value="">全部运输方式</option>
          <option value="sea">海运</option>
          <option value="land">陆运</option>
          <option value="none">未标注</option>
        </select>
        {(() => {
          // 陆运只给陆运的状态；海运和「未标注」（老柜子实际走海运）给海运的；
          // 没选运输方式时不让选状态 —— 否则又变成海陆混在一张单子里
          const modePicked = modeFilter === "sea" || modeFilter === "land" || modeFilter === "none";
          const options = modeFilter === "land" ? FILTER_STATUSES_LAND : FILTER_STATUSES_SEA;
          return (
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{ ...inputStyle, color: modePicked ? undefined : "var(--t-faint)" }}
              disabled={!modePicked}
              title={modePicked ? "" : "先选运输方式，再选对应的状态"}
            >
              <option value="ALL">{modePicked ? "全部状态" : "全部状态（先选运输方式）"}</option>
              {modePicked && options.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
              ))}
            </select>
          );
        })()}
        <button onClick={() => void loadList()} style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "var(--c-blue)", color: "var(--white)", fontWeight: 500, fontSize: 13, cursor: "pointer" }}>搜索</button>
        <button onClick={() => setShowCreate(!showCreate)} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 16px", background: "var(--white)", fontSize: 13, cursor: "pointer", color: "var(--t-strong)" }}>
          {showCreate ? "收起" : "+ 新建装柜"}
        </button>
      </div>

      {/* 新建表单 */}
      {showCreate && (
        <div style={{ border: "1px solid var(--l-soft)", borderRadius: 8, padding: 16, background: "var(--s-cool)", marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input value={createForm.containerNo} onChange={(e) => setCreateForm((v) => ({ ...v, containerNo: e.target.value }))} placeholder="柜号" style={{ ...inputStyle, minWidth: 150 }} />
          {/* 必选：后端只认 sea / land，不选会 400 */}
          <select value={createForm.transportMode} onChange={(e) => setCreateForm((v) => ({ ...v, transportMode: e.target.value }))} style={inputStyle} title="这个柜子走海运还是陆运">
            <option value="sea">海运</option>
            <option value="land">陆运</option>
          </select>
          <input value={createForm.voyage} onChange={(e) => setCreateForm((v) => ({ ...v, voyage: e.target.value }))} placeholder="船次" style={{ ...inputStyle, minWidth: 130 }} />
          <input value={createForm.vesselName} onChange={(e) => setCreateForm((v) => ({ ...v, vesselName: e.target.value }))} placeholder="船名" style={{ ...inputStyle, minWidth: 150 }} />
          <select value={createForm.warehouse} onChange={(e) => setCreateForm((v) => ({ ...v, warehouse: e.target.value }))} style={inputStyle}>
            <option value="wh_yiwu_01">义乌仓</option>
            <option value="wh_guangzhou_01">广州仓</option>
            <option value="wh_dongguan_01">东莞仓</option>
            <option value="wh_shenzhen_01">深圳仓</option>
          </select>
          <button disabled={creating} onClick={handleCreate} style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "var(--c-blue)", color: "var(--white)", fontWeight: 500, fontSize: 13, cursor: creating ? "not-allowed" : "pointer" }}>
            {creating ? "创建中…" : "创建"}
          </button>
        </div>
      )}

      {error && <p style={{ color: "var(--c-red-deep)", fontSize: 13, marginBottom: 8 }}>{error}</p>}

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16, alignItems: "start" }}>
        {/* 左侧柜列表
            2026-08-05：柜里最多能装 25 张运单，右边一翻，左边这列柜号就跟着滚没了，
            员工得翻回顶部才能换柜。改成贴住不动（sticky），自己太长时内部滚动。

            ⚠️ 这两个数字是量出来的，别随手改：
            滚动的不是窗口，是 RoleShell 的 .dashboard-content（globals.css:342，
            height calc(100vh - 48px) + overflow-y auto），sticky 是相对它生效的。
            它里面第一个孩子是 .glass-topbar（sticky、z-index:20）。

            2026-08-07 顶栏从 top:12 改成 top:0（原来那 12px 缝会漏出表格内容），
            顶栏底边跟着从 y=54 上移到 y=42，实测顶栏高 42px。
            所以这里同步从 68 改成 56（42 + 14 间距），写小了第一个柜号会被顶栏盖住。
            maxHeight 保持 calc(100vh - 92px) 不动：顶栏上移后可用高度只多不少，这个值仍在安全范围内。 */}
        <div style={{ border: "1px solid var(--l-soft)", borderRadius: 10, overflow: "hidden", background: "var(--white)", position: "sticky", top: 56, maxHeight: "calc(100vh - 92px)", overflowY: "auto" }}>
          {loading ? <p style={{ padding: 20, color: "var(--t-strong)", fontSize: 13 }}>加载中…</p> : list.length === 0 ? (
            <p style={{ padding: 20, color: "var(--t-strong)", fontSize: 13, textAlign: "center" }}>暂无装柜任务，请先创建装柜</p>
          ) : (
            list.map((item) => (
              <div key={item.id} onClick={() => selectManifest(item.id)} style={{ padding: "12px 16px", cursor: "pointer", borderBottom: "1px solid var(--s-cool-2)", background: selectedId === item.id ? "var(--c-blue-bg)" : "transparent" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: 14, color: "#14171D" }}>{item.manifestNo}</span>
                  <span style={{ fontSize: 11, fontWeight: 500, color: STATUS_COLOR[item.status] ?? "var(--t-strong)" }}>{STATUS_LABEL[item.status] ?? item.status}</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--t-strong)", marginTop: 4 }}>
                  <span style={{ color: item.transportMode ? "var(--c-navy)" : "var(--c-red-deep)", fontWeight: 600 }}>{MODE_ZH(item.transportMode)}</span>
                  {" · "}{WAREHOUSE_ZH[item.warehouse] ?? item.warehouse} · {item.totalBills} 票 · {item.createdAt.slice(0, 10)}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 右侧详情 + 运单列表 */}
        <div>
          {/* 柜子详情 */}
          <div style={{ border: "1px solid var(--l-soft)", borderRadius: 10, padding: 16, background: "var(--white)", marginBottom: 12 }}>
            {loadingDetail ? <p style={{ color: "var(--t-strong)", fontSize: 13 }}>加载中…</p> : detailError ? (
              /* 2026-09-02 复核整改：详情加载失败时旧详情已清空，这里显式给失败态 + 重试入口，
                 绝不让上一个柜的详情留在屏幕上冒充这个柜 */
              <p style={{ color: "var(--c-red-deep)", fontSize: 13 }}>
                详情加载失败：{detailError}
                <button
                  onClick={() => { if (selectedId) void loadDetail(selectedId); }}
                  style={{ marginLeft: 8, border: "1px solid var(--l-strong)", borderRadius: 4, padding: "2px 10px", fontSize: 12, background: "var(--white)", color: "var(--c-blue)", cursor: "pointer" }}
                >
                  点击重试
                </button>
              </p>
            ) : !detail ? (
              <p style={{ color: "var(--t-strong)", fontSize: 13 }}>选择左侧装柜任务查看详情</p>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#14171D" }}>{detail.manifestNo}</h2>
                    <div style={{ fontSize: 13, color: "var(--t-strong)", marginTop: 4, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span>运输方式:</span>
                      {/* 未标注的老柜子在这里补；已经走到某一方专属环节时后端会拒绝，
                          界面把报错原样弹出来（2026-08-06） */}
                      <select
                        value={detail.transportMode ?? ""}
                        onChange={async (e) => {
                          const mode = e.target.value;
                          if (!mode) return;
                          // 2026-09-02 复核整改：改运输方式也写库，先核对屏幕上的详情就是当前选中柜
                          if (!guardDetailOwner(selectedId)) return;
                          try {
                            await setManifestTransportMode(detail.id, mode);
                            setToast(`柜子「${detail.manifestNo}」已标为${mode === "land" ? "陆运" : "海运"}`);
                            setTargetStatus("");
                            setNextStop("");
                            await loadDetail(detail.id);
                            await loadList();
                          } catch (err) {
                            setError(err instanceof Error ? err.message : "改运输方式失败");
                          }
                        }}
                        style={{ ...inputStyle, padding: "2px 6px", fontSize: 13, color: detail.transportMode ? "var(--c-navy)" : "var(--c-red-deep)", fontWeight: 600 }}
                      >
                        {!detail.transportMode && <option value="">未标注（请选）</option>}
                        <option value="sea">海运</option>
                        <option value="land">陆运</option>
                      </select>
                      <span>
                        · 仓库: {WAREHOUSE_ZH[detail.warehouse] ?? detail.warehouse} · 状态: {STATUS_LABEL[detail.status] ?? detail.status}
                        {detail.carrierInfo ? ` · 船次/船名: ${detail.carrierInfo}` : ""}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <button
                      disabled={detail.bills.length === 0 || exportingContainerId === detail.id}
                      onClick={() => void handleExportContainer()}
                      title={detail.bills.length === 0 ? "空柜没有可导出的货物" : "按当前柜内货物生成给尾端拆柜仓的清单"}
                      style={{ border: "1px solid var(--c-blue)", borderRadius: 6, padding: "8px 16px", background: "var(--white)", color: detail.bills.length === 0 ? "var(--t-faint)" : "var(--c-blue)", fontWeight: 600, fontSize: 13, cursor: detail.bills.length === 0 ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
                    >
                      {exportingContainerId === detail.id ? "导出中…" : "导出整柜派送清单"}
                    </button>
                    <input value={statusRemark} onChange={(e) => setStatusRemark(e.target.value)} placeholder="备注（选填）" style={{ ...inputStyle, minWidth: 200, flex: 1 }} />
                    {/* 下一站：选了目标状态就自动填上默认值，员工想改可以直接改（2026-08-06） */}
                    <input
                      value={nextStop}
                      onChange={(e) => setNextStop(e.target.value)}
                      placeholder="下一站（选填）"
                      title="客户在物流轨迹里会看到「下一站【xxx】」。选了状态会自动填，可以改"
                      style={{ ...inputStyle, maxWidth: 160 }}
                    />
                    <input type="date" value={statusDate} onChange={(e) => setStatusDate(e.target.value)} style={{ ...inputStyle, maxWidth: 150 }} title="选择日期（不选则为当天）" />
                    {(() => {
                      // 没标运输方式的柜子先别给状态选项 —— 先选海运还是陆运，
                      // 再选对应的状态，两边的状态不放在一起（2026-08-06 用户要求）
                      if (!detail.transportMode) {
                        return (
                          <span style={{ fontSize: 12, color: "var(--c-red-deep)", whiteSpace: "nowrap" }}>
                            ← 先选运输方式，才能推进状态
                          </span>
                        );
                      }
                      const flow: readonly string[] = detail.transportMode === "land" ? STATUS_FLOW_LAND : STATUS_FLOW;
                      const currentIdx = flow.indexOf(detail.status);
                      if (currentIdx < 0 || currentIdx >= flow.length - 1) return null;
                      const options = flow.slice(currentIdx + 1);
                      return (
                        <>
                          <select
                            value={targetStatus}
                            onChange={(e) => {
                              setTargetStatus(e.target.value);
                              // 换目标状态时把下一站换成该状态的默认值，员工再决定要不要改
                              setNextStop(nextStopDefault(e.target.value, detail.transportMode));
                            }}
                            style={inputStyle}
                          >
                            <option value="">选择目标状态</option>
                            {options.map((s) => (
                              <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
                            ))}
                          </select>
                          <button
                            disabled={!targetStatus}
                            onClick={() => { if (targetStatus) handlePushStatus(targetStatus); setTargetStatus(""); }}
                            style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: targetStatus ? "var(--c-blue)" : "#8B94A3", color: "var(--white)", fontWeight: 500, fontSize: 13, cursor: targetStatus ? "pointer" : "not-allowed", whiteSpace: "nowrap" }}
                          >
                            确认推进
                          </button>
                        </>
                      );
                    })()}
                    {/* 推错了：整柜退回上一步，柜里每张运单那批轨迹一起删掉。
                        「装柜中」是第一步，没有上一步可退；
                        「派送中 / 已签收」是尾端派送那边推的，不归这里管（后端也会拒）——
                        所以这三种情况不显示按钮，别让人点了才看到报错。 */}
                    {!["LOADING", "OUT_FOR_DELIVERY", "SIGNED", "DELIVERING"].includes(detail.status) && (
                      <button
                        onClick={handleUndoStatus}
                        disabled={undoing}
                        style={{ border: "1px solid var(--l-soft)", borderRadius: 6, padding: "8px 16px", background: "var(--white)", color: undoing ? "var(--t-faint)" : "var(--c-red-deep)", fontWeight: 500, fontSize: 13, cursor: undoing ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
                      >
                        {undoing ? "撤销中…" : `撤销「${STATUS_LABEL[detail.status] ?? detail.status}」`}
                      </button>
                    )}
                    {detail.status === "LOADING" && (
                      <button onClick={handleDelete} style={{ border: "1px solid #fecaca", borderRadius: 6, padding: "8px 16px", background: "#fef2f2", color: "var(--c-red-2)", fontWeight: 500, fontSize: 13, cursor: "pointer" }}>删除柜子</button>
                    )}
                  </div>
                </div>

                {/* 已装运单列表 */}
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--t-strong)", marginBottom: 8 }}>已装运单（{detail.bills.length}）</div>
                {detail.bills.length === 0 ? (
                  <p style={{ color: "var(--t-strong)", fontSize: 13, marginBottom: 12 }}>暂无运单，从下方选择运单添加到本柜</p>
                ) : (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 0.7fr 0.5fr 0.4fr auto", gap: 4, padding: "4px 10px", fontSize: 11, color: "var(--t-muted)", fontWeight: 600, borderBottom: "1px solid var(--l-soft)" }}>
                      <span>运单号 / 父运单</span>
                      <span>唛头</span>
                      <span>产品/件数</span>
                      <span>运输</span>
                      <span>状态</span>
                      <span>操作</span>
                    </div>
                    {detail.bills.map((b) => (
                      <div key={b.id} style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 0.7fr 0.5fr 0.4fr auto", gap: 4, padding: "6px 10px", borderBottom: "1px solid var(--s-cool-2)", alignItems: "center", background: "var(--white)", fontSize: 12 }}>
                        <div>
                          <span style={{ fontWeight: 600, fontFamily: "monospace", color: "var(--c-navy)" }}>{b.trackingNo ?? "—"}</span>
                          {b.parentTrackingNo ? <span style={{ display: "block", fontSize: 10, color: "#1e3a8a" }}>← {b.parentTrackingNo}</span> : null}
                          {b.itemName ? <span style={{ display: "block", color: "var(--t-body)", marginTop: 1 }}>{b.itemName}</span> : null}
                        </div>
                        <span style={{ color: "#14171D", fontWeight: 500 }}>{b.clientId ?? "—"}</span>
                        <span style={{ color: "var(--t-body)" }}>{b.loadedPieces}件{b.packageCount != null ? ` / 共${b.packageCount}件` : ""}</span>
                        <span style={{ color: "var(--t-body)" }}>{b.transportMode === "sea" ? "海运" : b.transportMode === "land" ? "陆运" : "—"}</span>
                        <span style={{ color: STATUS_COLOR[b.currentStatus ?? ""] ?? "var(--t-strong)", fontWeight: 500 }}>{b.currentStatus ? shipmentStatusZh(b.currentStatus) : "—"}</span>
                        <div style={{ display: "flex", gap: 4 }}>
                          {/* 2026-08-06：这里原来只有状态文字，看不到轨迹，员工得跑回运单管理才能查 */}
                          <button
                            disabled={!b.trackingNo}
                            onClick={() => b.trackingNo && openShipmentTrack({ trackingNo: b.trackingNo })}
                            style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "2px 6px", fontSize: 11, background: "var(--white)", color: b.trackingNo ? "var(--c-navy)" : "var(--t-faint)", cursor: b.trackingNo ? "pointer" : "not-allowed", whiteSpace: "nowrap" }}
                          >
                            物流轨迹
                          </button>
                          <button onClick={() => { setUnloadDialog({itemId: b.id, loadedPieces: b.loadedPieces}); setUnloadCount(String(b.loadedPieces)); }} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "2px 6px", fontSize: 11, background: "var(--white)", color: "var(--c-red-2)", cursor: "pointer" }}>卸柜</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 运单列表（可添加到装柜） */}
          {detail && (
            <div style={{ border: "1px solid var(--l-soft)", borderRadius: 10, padding: 16, background: "var(--white)" }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#14171D", marginBottom: 8 }}>选择运单添加到本柜</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <input value={shipSearch.trackingNo} onChange={(e) => setShipSearch((v) => ({ ...v, trackingNo: e.target.value }))} placeholder="运单号" style={{ ...inputStyle, flex: 1, minWidth: 120 }} />
                <input value={shipSearch.clientId} onChange={(e) => setShipSearch((v) => ({ ...v, clientId: e.target.value }))} placeholder="唛头" style={{ ...inputStyle, flex: 1, minWidth: 120 }} />
                <select value={shipSearch.transportMode} onChange={(e) => setShipSearch((v) => ({ ...v, transportMode: e.target.value }))} style={inputStyle}>
                  <option value="">全部运输方式</option>
                  <option value="sea">海运</option>
                  <option value="land">陆运</option>
                </select>
                <button disabled={adding || Object.keys(selectedShipments).length === 0} onClick={handleBulkAdd} style={{ border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12, background: Object.keys(selectedShipments).length === 0 ? "var(--t-strong)" : "var(--c-blue)", color: "var(--white)", cursor: Object.keys(selectedShipments).length === 0 ? "not-allowed" : "pointer", fontWeight: 600 }}>
                  {adding ? "添加中…" : `添加选中（${Object.keys(selectedShipments).length}）`}
                </button>
              </div>
              {/* 选择件数弹窗 */}
              {bulkPieceDialog && (
                <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.3)" }} onClick={() => { setBulkPieceDialog(null); setBulkPieceCount(""); }}>
                  <div style={{ background: "var(--white)", borderRadius: 10, padding: 20, boxShadow: "0 8px 40px rgba(0,0,0,0.2)", minWidth: 300 }} onClick={e => e.stopPropagation()}>
                    <h4 style={{ margin: "0 0 10px", fontSize: 15 }}>装柜件数 — {bulkPieceDialog}</h4>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input type="number" value={bulkPieceCount} onChange={e => setBulkPieceCount(e.target.value)} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 12px", fontSize: 14, width: "100%" }} min="1" autoFocus />
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                      <button onClick={() => { setBulkPieceDialog(null); setBulkPieceCount(""); }} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 14px", background: "var(--white)", cursor: "pointer", fontSize: 13 }}>取消</button>
                      <button onClick={() => {
                        const n = parseInt(bulkPieceCount) || 0;
                        if (n > 0 && bulkPieceDialog) {
                          setSelectedShipments(p => ({ ...p, [bulkPieceDialog]: n }));
                        }
                        setBulkPieceDialog(null); setBulkPieceCount("");
                      }} style={{ border: "none", borderRadius: 6, padding: "6px 14px", background: "var(--c-blue)", color: "var(--white)", cursor: "pointer", fontSize: 13 }}>确认</button>
                    </div>
                  </div>
                </div>
              )}

              <div style={{ maxHeight: 300, overflow: "auto", border: "1px solid var(--s-cool-2)", borderRadius: 6 }}>
                {filteredShipments.length === 0 ? (
                  <p style={{ padding: 16, color: "var(--t-strong)", fontSize: 13, textAlign: "center" }}>暂无匹配运单</p>
                ) : filteredShipments.map((s) => {
                    const alreadyIn = existingShipmentIds.has(s.id);
                    const loadedContainer = loadedShipments[s.id];
                    const isSelected = s.trackingNo in selectedShipments;
                    const remaining = s.packageCount ?? 0;
                    const isParent = !s.parentTrackingNo;
                    const totalPkg = s.totalPackageCount ?? remaining;
                    const children = isParent ? allShipments.filter(c => c.parentTrackingNo === s.trackingNo) : [];
                    const loadedChildren = children.filter(c => loadedShipments[c.id]);
                    return (
                      <div key={s.id} style={{ padding: "8px 10px", borderBottom: "1px solid var(--s-cool-2)", opacity: alreadyIn ? 0.5 : 1, background: isSelected ? "var(--c-blue-bg)" : "transparent" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input type="checkbox" checked={isSelected || alreadyIn} disabled={alreadyIn || (isParent && remaining === 0)} onChange={() => {
                            if (alreadyIn || (isParent && remaining === 0)) return;
                            if (isSelected) { const n = { ...selectedShipments }; delete n[s.trackingNo]; setSelectedShipments(n); }
                            else { setBulkPieceDialog(s.trackingNo); setBulkPieceCount(String(remaining)); }
                          }} />
                          <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "monospace", color: "var(--c-navy)", minWidth: 150 }}>{s.trackingNo}</span>
                          <span style={{ fontSize: 12, color: "#14171D", minWidth: 60 }}>{s.clientId ?? "—"}</span>
                          <span style={{ fontSize: 12, color: "var(--t-strong)", minWidth: 140 }}>
                            {isParent ? `共${totalPkg}件` : `${totalPkg}件`}
                            {isParent && remaining < totalPkg ? <span style={{ color: "var(--c-green)", fontWeight: 600 }}>（剩{remaining}件）</span> : null}
                          </span>
                          {isSelected && <span style={{ fontSize: 11, color: "var(--c-blue)", fontWeight: 600 }}>装{selectedShipments[s.trackingNo]}件</span>}
                          <span style={{ fontSize: 12, color: "var(--t-strong)", minWidth: 50 }}>{s.transportMode === "sea" ? "海运" : s.transportMode === "land" ? "陆运" : "—"}</span>
                          <span style={{ fontSize: 12, color: alreadyIn ? "var(--c-green-3)" : loadedContainer ? "#B45309" : "var(--t-strong)" }}>{alreadyIn ? "已在本柜" : loadedContainer ? `已装柜(${loadedContainer})` : s.currentStatus ? shipmentStatusZh(s.currentStatus) : ""}</span>
                        </div>
                        {loadedChildren.length > 0 && (
                          <div style={{ paddingLeft: 28, fontSize: 11, color: "var(--t-muted)", marginTop: 3 }}>
                            {loadedChildren.map(c => (
                              <span key={c.id} style={{ marginRight: 14 }}>{c.trackingNo}: {c.packageCount}件 → {loadedShipments[c.id]}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      </div>

      
      {unloadDialog && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.3)" }} onClick={() => setUnloadDialog(null)}>
          <div style={{ background: "var(--white)", borderRadius: 10, padding: 20, boxShadow: "0 8px 40px rgba(0,0,0,0.2)", minWidth: 300 }} onClick={e => e.stopPropagation()}>
            <h4 style={{ margin: "0 0 10px", fontSize: 15 }}>卸柜件数</h4>
            <input type="number" value={unloadCount} onChange={e => setUnloadCount(e.target.value)} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 12px", fontSize: 14, width: "100%" }} min="1" max={unloadDialog.loadedPieces} autoFocus />
            <div style={{ fontSize: 11, color: "var(--t-muted)", marginTop: 4 }}>当前装柜 {unloadDialog.loadedPieces} 件</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={() => setUnloadDialog(null)} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 14px", background: "var(--white)", cursor: "pointer", fontSize: 13 }}>取消</button>
              <button onClick={() => { const n = parseInt(unloadCount); if (n > 0 && unloadDialog) { handleRemoveShipment(unloadDialog.itemId, n === unloadDialog.loadedPieces ? undefined : n); } setUnloadDialog(null); }} style={{ border: "none", borderRadius: 6, padding: "6px 14px", background: "var(--c-red-2)", color: "var(--white)", cursor: "pointer", fontSize: 13 }}>确认卸柜</button>
            </div>
          </div>
        </div>
      )}
      <Toast open={toast.length > 0} message={toast} />
    </>
  );
}
