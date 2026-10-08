"use client";

/**
 * 「到货通知」页面（2026-10-06 老板：「国内仓库到货后，同事把货物记录在『到货通知』里面，由客服在系统直接复制文案，
 * 图片然后去告知客户。通知完成之后，可以修改状态为『已通知客户』，然后还可以转入到运单列表里面」）。
 *
 * 员工和超管共用这一页（超管菜单也指到 /staff/arrival-notices，跟「装柜管理」「客户消息」一样）。
 * 一票货一块：上面是给客户的文案（点「复制文案」），旁边是照片（「复制」「保存」），下面一排按钮：
 * 标已通知、修改、转正式运单、转待入库、删除。转运单由员工自己选，系统只查缺什么（规矩见后端 routes.ts 开头）。
 * 同事登记、转单，服务器马上推过来，这一页悄悄重拉（老板 10-05：「不能有延迟」）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import DetailModal from "../layout/DetailModal";
import Toast from "../layout/Toast";
import { useLiveRefresh } from "../realtime/useRealtime";
import { createRequestGate } from "../shared/request-gate";
import { beijingToday } from "../shared/beijing-date";
import { compressImageForUpload } from "../shared/image-compress";
import { openShipmentTrack } from "../shipment/ShipmentTrackModal";
import { shipmentStatusZh } from "../shipment/shipment-status";
import { apiBaseUrl } from "../../services/core-api";
import { fetchStaffClients } from "../../services/business-api";
import MarkPicker, { type MarkOption } from "../layout/MarkPicker";
import {
  convertArrivalNotice,
  deleteArrivalNotice,
  deleteArrivalNoticeImage,
  fetchArrivalNotices,
  saveArrivalNotice,
  setArrivalNoticeNotified,
  uploadArrivalNoticeImage,
  type ArrivalNotice,
  type ArrivalNoticeDraft,
  type ArrivalNoticeImage,
  type ArrivalNoticePage,
  type ArrivalNoticeTab,
  type PrealertMatch,
} from "../../services/arrival-notice-api";
import { buildArrivalNoticeText } from "./notice-text";
import { missingForFormal } from "./missing";
import { copyImage, copyText, saveImage } from "./copy-helpers";
import { CLIENT_CHANGED_NOTE, MAX_NOTICE_IMAGES, photoFailMessage, photoSlotsLeft, pickPhotos, uploadQueuedPhotos } from "./photo-upload";
import { makeThumb } from "./photo-thumb";
import { CARGO_TYPES, CARGO_TYPE_ZH, type CargoType } from "../../../../../packages/shared-types/cargo-type";

const PAGE_SIZE = 30;

const TAB_LABELS: Array<{ key: ArrivalNoticeTab; label: string }> = [
  { key: "todo", label: "待通知" },
  { key: "notified", label: "已通知" },
  { key: "inbound", label: "待入库" },
  { key: "formal", label: "已转运单" },
  { key: "all", label: "全部" },
];

const WAREHOUSES = [
  { id: "wh_yiwu_01", label: "义乌仓" },
  { id: "wh_guangzhou_01", label: "广州仓" },
  { id: "wh_dongguan_01", label: "东莞仓" },
  { id: "wh_shenzhen_01", label: "深圳仓" },
];
const WAREHOUSE_ZH: Record<string, string> = Object.fromEntries(WAREHOUSES.map((w) => [w.id, w.label]));

/** 上次登记选的仓库（每台电脑记自己的，只是省一下点选） */
const LAST_WAREHOUSE_KEY = "xt_arrival_last_warehouse";

function shortTime(iso: string | null): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** 原图：点开大图、复制、保存 */
function imgSrc(img: ArrivalNoticeImage): string {
  return apiBaseUrl() + img.imageUrl;
}

/** 小方块（卡片 / 修改弹窗）用小图（G03）；老照片、老后端没有小图就用原图 */
function thumbSrc(img: ArrivalNoticeImage): string {
  return apiBaseUrl() + (img.thumbUrl ?? img.imageUrl);
}

/** 认不出来的值（含 null = 普货）一律按普货 */
function cargoTypeOf(v: string | null | undefined): CargoType {
  return (CARGO_TYPES as readonly string[]).includes(v ?? "") ? (v as CargoType) : "normal";
}

/** 一张撞上的预报单怎么说（F01）：「YWYB…（唛头 X，国内单号 Y，已确认收货）」 */
function prealertLabel(m: PrealertMatch): string {
  return `${m.trackingNo ?? "（没有单号）"}（唛头 ${m.clientId}，国内单号 ${m.domesticTrackingNo}${m.received ? "，已确认收货" : ""}）`;
}

function emptyDraft(): ArrivalNoticeDraft {
  let warehouseId = "";
  try { warehouseId = window.localStorage.getItem(LAST_WAREHOUSE_KEY) ?? ""; } catch { /* 隐私模式读不了就算了 */ }
  if (!WAREHOUSE_ZH[warehouseId]) warehouseId = "";
  return {
    clientId: "", trackingNo: "", itemName: "", packageCount: "", weightKg: "", volumeM3: "",
    transportMode: "", cargoType: "normal", domesticTrackingNo: "", warehouseId, arrivedAt: beijingToday(), remark: "",
  };
}

function draftOf(n: ArrivalNotice): ArrivalNoticeDraft {
  const s = (v: string | number | null) => (v === null || v === undefined ? "" : String(v));
  return {
    clientId: n.clientId ?? "",
    trackingNo: s(n.trackingNo),
    itemName: s(n.itemName),
    packageCount: s(n.packageCount),
    weightKg: s(n.weightKg),
    volumeM3: s(n.volumeM3),
    transportMode: n.transportMode === "sea" || n.transportMode === "land" ? n.transportMode : "",
    cargoType: cargoTypeOf(n.cargoType),
    domesticTrackingNo: s(n.domesticTrackingNo),
    warehouseId: n.warehouseId ?? "",
    arrivedAt: s(n.arrivedAt),
    remark: s(n.remark),
  };
}

/** seq：每打开一次弹窗领一个号。关 / 存完只关「自己那一个」，晚到的回调关不掉后来打开的（F05） */
type Editor = { mode: "new"; seq: number } | { mode: "edit"; item: ArrivalNotice; seq: number };

export default function ArrivalNoticesView() {
  const [tab, setTab] = useState<ArrivalNoticeTab>("todo");
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ArrivalNoticePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  /** 正在处理的卡片 / 照片 id。一个 id 一份（修复第 1 轮）：原来全页一个 busyId，A 还在转单时点 B 的「保存」，A 的按钮就提前亮了，
      B 一结束又清成 null —— A 的请求没回来就能再点一次「转正式运单」/「删除」 */
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);
  const [toast, setToast] = useState<{ seq: number; message: string; tone: "success" | "error" }>({ seq: 0, message: "", tone: "success" });
  const [clients, setClients] = useState<MarkOption[]>([]);
  const [clientsFailed, setClientsFailed] = useState(false);
  const gate = useRef(createRequestGate());
  /** 屏幕上这份列表是哪个页签 / 搜索词 / 页码的（F12：悄悄重拉失败时判断要不要报错） */
  const shownKeyRef = useRef<string | null>(null);
  const editorSeq = useRef(0);

  const say = useCallback((message: string, tone: "success" | "error" = "success") => {
    setToast((t) => ({ seq: t.seq + 1, message, tone }));
  }, []);

  // 搜索框停手 300 毫秒再查，回到第 1 页
  useEffect(() => {
    const t = window.setTimeout(() => { setKeyword(keywordInput.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(t);
  }, [keywordInput]);

  const load = useCallback(async (silent: boolean) => {
    const key = JSON.stringify([tab, keyword, page]);
    const ticket = gate.current.begin();
    if (!silent) setLoading(true);
    try {
      const res = await fetchArrivalNotices({ tab, keyword, page, pageSize: PAGE_SIZE });
      if (!gate.current.isCurrent(ticket)) return;
      // 删掉 / 转走了最后一页的最后一条：别停在空白页，退回上一页
      if (res.items.length === 0 && page > 1) { setPage((p) => Math.max(1, p - 1)); return; }
      setData(res);
      shownKeyRef.current = key;
      setLoadError("");
    } catch (e) {
      if (!gate.current.isCurrent(ticket)) return;
      // 悄悄重拉失败：手上显示的就是这个页签的，接着显示、不弹错；
      // 手上的还是别的页签的（切页签那次请求被这次顶掉了），不说的话就是「亮着 A、列着 B」（F12）
      if (!silent || shownKeyRef.current !== key) setLoadError(e instanceof Error ? e.message : "加载失败");
    } finally {
      // 不论悄悄与否：它是最新的那次，加载就算结束了（它顶掉的那次不会再来关）
      if (gate.current.isCurrent(ticket)) setLoading(false);
    }
  }, [tab, keyword, page]);

  useEffect(() => { void load(false); }, [load]);

  /* F12：操作（标已通知 / 转运单 / 删除 / 弹窗存完）回来后的刷新，用**现在**的页签、搜索词、页码，
     不是点按钮那一刻的。原来 await 完调的是点按钮那次渲染的 load：期间切了页签，旧页签的数据会盖掉新页签，
     还把新页签那次请求作废（request-gate.ts 文件头「过期上下文的刷新不许领号」）。 */
  const loadRef = useRef(load);
  useLayoutEffect(() => { loadRef.current = load; }, [load]);
  const reloadLatest = useCallback(() => loadRef.current(true), []);

  const openEditor = (e: { mode: "new" } | { mode: "edit"; item: ArrivalNotice }) => {
    editorSeq.current += 1;
    setEditor({ ...e, seq: editorSeq.current });
  };
  /** 只关 seq 这一个弹窗；已经换成别的弹窗了就不动（F05） */
  const closeEditor = (seq: number) => setEditor((cur) => (cur && cur.seq === seq ? null : cur));

  useLiveRefresh({
    topics: ["shipping"],
    refresh: async (isStillWanted) => { if (isStillWanted()) await load(true); },
  });

  useEffect(() => {
    let cancelled = false;
    // 唛头下拉只要唛头（显示唛头不带客户名字，老板 09-19）；拿不到也能手输
    fetchStaffClients().then((items) => { if (!cancelled) setClients(items.map((c) => ({ id: c.id }))); }).catch(() => { if (!cancelled) setClientsFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const run = async (id: string, work: () => Promise<void>) => {
    setBusyIds((cur) => new Set(cur).add(id));
    try { await work(); } catch (e) { say(e instanceof Error ? e.message : "操作失败", "error"); }
    finally {
      // 只放开自己这一个，别的卡片还在跑的不动
      setBusyIds((cur) => { const next = new Set(cur); next.delete(id); return next; });
    }
  };

  const onCopyText = async (n: ArrivalNotice) => {
    const okCopy = await copyText(buildArrivalNoticeText(n));
    say(okCopy ? "文案已复制，去微信 / LINE 粘贴发给客户" : "没复制上，请手动选中上面的文字复制", okCopy ? "success" : "error");
  };
  const onCopyImage = async (img: ArrivalNoticeImage) => {
    const okCopy = await copyImage(imgSrc(img));
    say(okCopy ? "图片已复制，去微信 / LINE 粘贴" : "这台设备不能直接复制图片，请点「保存」再发", okCopy ? "success" : "error");
  };
  const onSaveImage = (img: ArrivalNoticeImage) => run(img.id, async () => { await saveImage(imgSrc(img), img.fileName); });

  const onToggleNotified = (n: ArrivalNotice) => run(n.id, async () => {
    try {
      // G01：标「已通知」时带上页面上看到的唛头 —— 同事刚改了唛头的话后端 409，不把「已通知」记到新客户头上
      await setArrivalNoticeNotified(n.id, !n.notifiedAt, n.clientId);
    } catch (e) {
      void reloadLatest(); // 被挡多半是同事刚改过：刷出最新的再让他看
      throw e;
    }
    say(n.notifiedAt ? "已改回「未通知」" : "已标为「已通知客户」");
    await reloadLatest();
  });

  const onConvert = (n: ArrivalNotice, to: "formal" | "inbound") => {
    const ask = to === "formal"
      ? `把 ${n.trackingNo ?? "这票货"} 转成正式运单（状态「已入库」）？\n转完这条到货通知就只能看、不能改了。`
      : `把 ${n.trackingNo ?? "这票货"} 转成「待入库」运单？\n客户在「运单查询」里会看到「待入库」；资料补全后回这里点「转正式运单」。`;
    // F01：同一个国内单号客户报过预报单 —— 有预报单的货该走「预报单审核」，这里再转就多一张运单。不藏按钮（单号可能被别的客户用过、预报单也可能是废的），列清楚让员工自己确认
    const matches = n.prealertMatches ?? [];
    const matchList = matches.map((m) => `· ${prealertLabel(m)}`).join("\n");
    /* 待入库 → 正式用的是转待入库时建的那张运单，不会再多一张（后端 convert 的 if (ship) 分支）；
       多的那张转待入库时就有了 —— 跟卡片上那句同一个说法，别叫员工点「取消」（取消了多的照样在，这票货还卡在待入库）。修复第 1 轮 */
    const prealertAsk = !matches.length
      ? ""
      : to === "formal" && n.convertedTo === "inbound"
        ? `\n\n⚠️ 同一个国内单号，客户另外报过预报单：\n${matchList}\n转待入库时已经建过运单，现在可能有两张运单。转正式用的是同一张、不会再多建；转完请到「运单管理」核对，删掉多的那张。`
        : `\n\n⚠️ 同一个国内单号，客户报过预报单：\n${matchList}\n有预报单的货应该到「预报单审核」点「确认收货」，在这里转会多出一张运单。确定是两票不同的货才点确定。`;
    // F02：没通知就转，提醒一句（登记的人和通知的客服可以不是同一个人）
    const unnotified = n.notifiedAt ? "" : "\n\n注意：这票货还没标「已通知客户」。通知完记得回来点「标为已通知客户」。";
    if (!window.confirm(ask + prealertAsk + unnotified)) return;
    void run(n.id, async () => {
      try {
        await convertArrivalNotice(n.id, to, matches.map((m) => m.orderId));
      } catch (e) {
        void reloadLatest(); // 409（刚冒出一张没确认过的预报单 / 被同事改过）：刷出最新的，卡片上的提醒跟着出来
        throw e;
      }
      say(to === "formal" ? "已转成正式运单，「运单管理」里能看到" : "已转成待入库，资料补全后点「转正式运单」");
      await reloadLatest();
    });
  };

  const onDelete = (n: ArrivalNotice) => {
    if (!window.confirm(`删除这条到货通知${n.trackingNo ? `（${n.trackingNo}）` : ""}？照片一起删，删了找不回来。`)) return;
    void run(n.id, async () => {
      await deleteArrivalNotice(n.id);
      say("已删除");
      await reloadLatest();
    });
  };

  const counts = data?.counts;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="an-page">
      <div className="an-toolbar">
        <div className="an-tabs" role="tablist" aria-label="到货通知分类">
          {TAB_LABELS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`an-tab${tab === t.key ? " is-active" : ""}`}
              onClick={() => { setTab(t.key); setPage(1); }}
            >
              {t.label}
              {counts ? <span className="an-tab-count">{counts[t.key]}</span> : null}
            </button>
          ))}
        </div>
        <div className="an-toolbar-right">
          <input
            className="an-search"
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            placeholder="搜唛头 / 运单号 / 国内单号 / 品名"
            aria-label="搜索到货通知"
          />
          <button type="button" className="an-btn an-btn-primary" onClick={() => openEditor({ mode: "new" })}>＋ 登记到货</button>
        </div>
      </div>

      {loadError ? (
        <p role="alert" className="an-error">
          列表没取到：{loadError}{" "}
          <button type="button" className="an-link" onClick={() => void load(false)}>重试</button>
        </p>
      ) : null}

      {loading && !data ? <p className="an-muted an-pad">加载中…</p> : null}
      {data && data.items.length === 0 ? (
        <div className="an-empty">
          {keyword ? `没有搜到「${keyword}」` : tab === "todo" ? "没有要通知的到货。新到的货点右上角「登记到货」。" : "这里还没有记录。"}
        </div>
      ) : null}

      <div className="an-list">
        {data?.items.map((n) => (
          <NoticeCard
            key={n.id}
            n={n}
            busy={busyIds.has(n.id)}
            busyIds={busyIds}
            onCopyText={() => void onCopyText(n)}
            onCopyImage={(img) => void onCopyImage(img)}
            onSaveImage={(img) => void onSaveImage(img)}
            onPreview={(img) => setPreview({ src: imgSrc(img), alt: img.fileName })}
            onToggleNotified={() => void onToggleNotified(n)}
            onEdit={() => openEditor({ mode: "edit", item: n })}
            onConvert={(to) => onConvert(n, to)}
            onDelete={() => onDelete(n)}
          />
        ))}
      </div>

      {data && data.total > PAGE_SIZE ? (
        <div className="an-pager">
          <button type="button" className="an-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
          <span>第 {page} / {totalPages} 页，共 {data.total} 条</span>
          <button type="button" className="an-btn" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</button>
        </div>
      ) : null}

      {editor ? (
        <NoticeEditor
          // 加前缀：同一层还有 <Toast key={toast.seq}>，两个都是从 1 数起的数字，撞上同一个 key 时
          // React 会认错元素，存完 / 点 ✕ 弹窗关不掉、卡在「保存中…」（10-08 实点：两边都数到 7 时撞上）
          key={`editor-${editor.seq}`}
          editor={editor}
          clients={clients}
          clientsFailed={clientsFailed}
          onClose={() => closeEditor(editor.seq)}
          onSaved={(message) => { closeEditor(editor.seq); say(message); void reloadLatest(); }}
          onChanged={reloadLatest}
        />
      ) : null}

      {preview ? (
        <div className="an-preview" role="dialog" aria-label="照片大图" onClick={() => setPreview(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview.src} alt={preview.alt} />
        </div>
      ) : null}

      <Toast key={toast.seq} open={toast.message.length > 0} message={toast.message} tone={toast.tone} />
    </div>
  );
}

function NoticeCard(props: {
  n: ArrivalNotice;
  busy: boolean;
  /** 照片「保存」按钮看自己那张在不在里面 */
  busyIds: ReadonlySet<string>;
  onCopyText: () => void;
  onCopyImage: (img: ArrivalNoticeImage) => void;
  onSaveImage: (img: ArrivalNoticeImage) => void;
  onPreview: (img: ArrivalNoticeImage) => void;
  onToggleNotified: () => void;
  onEdit: () => void;
  onConvert: (to: "formal" | "inbound") => void;
  onDelete: () => void;
}) {
  const { n, busy } = props;
  const text = useMemo(() => buildArrivalNoticeText(n), [n]);
  const missing = missingForFormal(n);
  const formal = n.convertedTo === "formal";
  const inbound = n.convertedTo === "inbound";
  const mode = n.transportMode === "sea" ? "海运" : n.transportMode === "land" ? "陆运" : "";
  // F06：转出去的运单按 id 查轨迹（号在「运单管理」可能改过；卡片上的 trackingNo 后端已经给的是运单现在的号）
  const trackShipmentId = formal || inbound ? n.shipmentId : null;
  // F01：同一个国内单号客户报过预报单（老后端不回 = 没有）
  const prealerts = n.prealertMatches ?? [];
  const meta: Array<[string, string]> = [
    ["运单号", n.trackingNo ?? ""],
    ["品名", n.itemName ?? ""],
    ["重量", n.weightKg !== null ? `${n.weightKg} kg` : ""],
    ["体积", n.volumeM3 !== null ? `${n.volumeM3} m³` : ""],
    ["运输方式", mode],
    ["货型", CARGO_TYPE_ZH[cargoTypeOf(n.cargoType)]],
    ["国内单号", n.domesticTrackingNo ?? ""],
    ["到仓日期", n.arrivedAt ?? ""],
  ];

  return (
    <article className={`an-card${formal ? " is-done" : ""}`} aria-busy={busy}>
      <header className="an-card-head">
        <div className="an-card-title">
          <strong>{n.clientId ?? "唛头未填"}</strong>
          <span>{n.warehouseId ? (WAREHOUSE_ZH[n.warehouseId] ?? n.warehouseId) : "仓库未选"}</span>
          <span>{n.packageCount !== null ? `${n.packageCount} 件` : "件数未填"}</span>
        </div>
        <div className="an-chips">
          {n.notifiedAt
            // 谁通知的只有超管看得到（后端给员工不带名字，老板 2026-09-15 定的）
            ? <span className="an-chip an-chip-ok">已通知 · {[n.notifiedByName, shortTime(n.notifiedAt)].filter(Boolean).join(" ")}</span>
            : <span className="an-chip an-chip-warn">未通知</span>}
          {formal ? <span className="an-chip an-chip-ok">已转运单{n.shipmentStatus && n.shipmentStatus !== "inWarehouseCN" ? ` · ${shipmentStatusZh(n.shipmentStatus)}` : ""}</span> : null}
          {inbound ? <span className="an-chip an-chip-warn">待入库</span> : null}
          {n.shipmentGone ? <span className="an-chip an-chip-bad">原来转的运单已被删除，可以重新转</span> : null}
        </div>
      </header>

      <div className="an-card-body">
        <div className="an-text">
          <pre className="an-text-box">{text}</pre>
          <button type="button" className="an-btn an-btn-primary" onClick={props.onCopyText}>复制文案</button>
        </div>
        <div className="an-photos">
          {n.images.length === 0 ? <span className="an-muted">没有照片{formal ? "" : "（点「修改」可以加）"}</span> : null}
          {n.images.map((img) => (
            <figure key={img.id} className="an-photo">
              {/* G03：小方块用小图、滚到了再下（一页 30 条，每条最多 20 张）；点开大图用原图 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumbSrc(img)} alt={img.fileName} loading="lazy" decoding="async" onClick={() => props.onPreview(img)} />
              <figcaption>
                <button type="button" className="an-link" onClick={() => props.onCopyImage(img)}>复制</button>
                <button type="button" className="an-link" disabled={props.busyIds.has(img.id)} onClick={() => props.onSaveImage(img)}>保存</button>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>

      <dl className="an-meta">
        {meta.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd className={v ? "" : "is-empty"}>{v || "未填"}</dd></div>
        ))}
      </dl>
      {n.remark ? <p className="an-remark">备注（内部看，不进文案）：{n.remark}</p> : null}
      {prealerts.length > 0 ? (
        <p className="an-missing">
          {formal || inbound
            ? `客户另外报过预报单 ${prealerts.map(prealertLabel).join("；")}：现在可能有两张运单，核对后到「运单管理」删掉多的`
            : `客户报过预报单 ${prealerts.map(prealertLabel).join("；")}。有预报单的货请到「预报单审核」点「确认收货」，不要在这里转运单，不然会多一张运单`}
        </p>
      ) : null}
      {!formal && missing.length > 0 ? (
        <p className="an-missing">转正式运单还缺：{missing.join("、")}{inbound || missing.includes("运单号") || missing.includes("唛头") ? "" : "（可以先转待入库）"}</p>
      ) : null}

      <footer className="an-actions">
        <span className="an-who">{n.createdByName ? `${n.createdByName} ` : ""}登记于 {shortTime(n.createdAt)}</span>
        <button type="button" className="an-btn" disabled={busy} onClick={props.onToggleNotified}>{n.notifiedAt ? "改回未通知" : "标为已通知客户"}</button>
        {!formal ? <button type="button" className="an-btn" disabled={busy} onClick={props.onEdit}>修改</button> : null}
        {!formal ? <button type="button" className="an-btn an-btn-go" disabled={busy} onClick={() => props.onConvert("formal")}>转正式运单</button> : null}
        {!formal && !inbound ? <button type="button" className="an-btn" disabled={busy} onClick={() => props.onConvert("inbound")}>转待入库</button> : null}
        {trackShipmentId ? (
          <button type="button" className="an-btn" onClick={() => openShipmentTrack({ shipmentId: trackShipmentId })}>物流轨迹</button>
        ) : null}
        {!formal && !inbound ? <button type="button" className="an-btn an-btn-danger" disabled={busy} onClick={props.onDelete}>删除</button> : null}
      </footer>
    </article>
  );
}

function NoticeEditor(props: {
  editor: Editor;
  clients: MarkOption[];
  clientsFailed: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
  /** 修改时当场删了照片：列表跟着刷新 */
  onChanged: () => void | Promise<unknown>;
}) {
  const editing = props.editor.mode === "edit" ? props.editor.item : null;
  const [draft, setDraft] = useState<ArrivalNoticeDraft>(() => (editing ? draftOf(editing) : emptyDraft()));
  /** 新登记存过一次之后就有 id 了：照片没传完再点「保存」是接着传，不能再登记出一条新的 */
  const [savedId, setSavedId] = useState<string | null>(editing?.id ?? null);
  /** 库里那份（打开时 / 每次存上以后）：保存时一起传，后端比一下有没有人在这期间改过 */
  const [base, setBase] = useState<ArrivalNoticeDraft | null>(() => (editing ? draftOf(editing) : null));
  const [images, setImages] = useState<ArrivalNoticeImage[]>(editing?.images ?? []);
  /** 库里这条现在算不算「已通知」（存上以后跟着接口回来的那份走）—— G01 换唛头提醒用 */
  const [notifiedAt, setNotifiedAt] = useState<string | null>(editing?.notifiedAt ?? null);
  /** 选照片超过上限时，哪几张没加进框（F14） */
  const [pickNote, setPickNote] = useState("");
  const [queued, setQueued] = useState<Array<{ file: File; url: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  /** 弹窗关了 / 正在关：后面的照片不再传，也不再回调父页面的 onSaved（F05） */
  const cancelledRef = useRef(false);
  /** 资料存上那一刻要跟员工说、但照片没传完被截住的话（G01 那句）。弹窗每开一次换一个实例（key=editor-seq），不会带到下一次 */
  const savedNoteRef = useRef("");

  // 关掉弹窗时：叫停还在传的照片；把还没传的预览图放掉（移除 / 传完的那一张当场放）
  useEffect(() => {
    cancelledRef.current = false; // StrictMode 开发模式会先卸再装，装回来复位（否则 next dev 下照片永远不传、卡在保存中）
    return () => {
      cancelledRef.current = true;
      queuedRef.current.forEach((q) => URL.revokeObjectURL(q.url));
    };
  }, []);

  const set = <K extends keyof ArrivalNoticeDraft>(k: K, v: ArrivalNoticeDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const clientKnown = !draft.clientId || props.clients.length === 0 || props.clients.some((c) => c.id === draft.clientId);
  /* F15：唛头下拉不截断（原来 .slice(0, 50)）—— MarkPicker 用 filterMarkOptions，空查询给全部 */
  /* G01：这条已标「已通知客户」、又把原来的唛头换成别的（或清空）—— 新唛头的客户其实没被通知过，保存时后端会改回「未通知」。
     原来没唛头、这次补上的后端不动，这里也不提醒（R8），不然页面说「会改回未通知」结果没改 */
  const savedClient = base ? (base.clientId.trim() === "" ? null : base.clientId) : null;
  const draftClient = draft.clientId.trim() === "" ? null : draft.clientId;
  const clientChangedAfterNotify = Boolean(editing && notifiedAt && savedClient !== null && draftClient !== savedClient);
  const slotsLeft = photoSlotsLeft(images.length, queued.length);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    // F14：一条最多 MAX_NOTICE_IMAGES 张；修复第 1 轮：HEIC（电脑浏览器显示不了）、认不出的文件也不加。
    // 没加的都写进提示、列出文件名（教训 19：不许静默丢），规则在 pickPhotos
    const { take, note } = pickPhotos(Array.from(files), photoSlotsLeft(images.length, queuedRef.current.length));
    setPickNote(note);
    setQueued((q) => [...q, ...take.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
    if (fileRef.current) fileRef.current.value = "";
  };
  const unqueue = (url: string) => {
    URL.revokeObjectURL(url);
    setQueued((list) => list.filter((q) => q.url !== url));
  };

  const removeExisting = async (img: ArrivalNoticeImage) => {
    if (!window.confirm("删除这张照片？")) return;
    try {
      const r = await deleteArrivalNoticeImage(img.id);
      setImages(r.item.images);
      props.onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "照片没删掉");
    }
  };

  const submit = async () => {
    setError("");
    setSaving(true);
    let id = savedId;
    let existingCount = images.length;
    let doneMessage = editing ? "已保存" : "已登记，可以复制文案通知客户了";
    try {
      const { item } = await saveArrivalNotice(id, draft, base);
      id = item.id;
      existingCount = item.images.length;
      // G01：换了唛头、后端把「已通知」改回去了 —— 按接口真回来的说，不按自己猜的
      // 记进 savedNoteRef：照片没传完、再点保存时 base 已是新唛头、notifiedAt 已是 null，第二次算不出来，不记就丢了（10-08 修复审查）
      if (clientChangedAfterNotify && !item.notifiedAt) savedNoteRef.current = CLIENT_CHANGED_NOTE;
      else if (item.notifiedAt) savedNoteRef.current = ""; // 中间又被标了「已通知」：那句不成立了
      if (savedNoteRef.current) doneMessage = `已保存。${savedNoteRef.current}`;
      setNotifiedAt(item.notifiedAt);
      // F01：同一个国内单号客户报过预报单，存完就提醒（卡片上也会一直挂着）
      const matches = item.prealertMatches ?? [];
      if (matches.length) {
        doneMessage += item.convertedTo
          ? `。注意：客户另外报过预报单 ${matches.map(prealertLabel).join("；")}，现在可能有两张运单，核对后到「运单管理」删掉多的`
          : `。注意：客户报过预报单 ${matches.map(prealertLabel).join("；")}，有预报单的货请到「预报单审核」点「确认收货」，不要在这里转运单`;
      }
      setSavedId(item.id);
      // 存上了：库里现在就是这份。照片没传完再点「保存」时拿它比，不会把自己刚存的当成别人改的
      setBase(draftOf(item));
      setImages(item.images);
      if (draft.warehouseId) {
        try { window.localStorage.setItem(LAST_WAREHOUSE_KEY, draft.warehouseId); } catch { /* 记不住就算了 */ }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "没保存上");
      /* 没存上（比如被同事抢先改了）：列表马上刷一次，关掉重开「修改」拿到的才是最新的。
         不刷的话，自动刷新没赶上（页面在后台时推送是断开的）列表还是旧的，重开还是旧的、再存又被挡，转圈出不去（10-06 实点发现）。
         **等刷完**再放开按钮（「取消」在保存中是灰的）：不等的话网慢时点「取消」马上重开，拿到的还是旧的（Codex 第二轮 S2） */
      // 最多等 5 秒：网慢 / 请求卡住时别让「取消」一直灰着（右上角 ✕ 本来就一直能点）—— dsh 第三轮 A
      try { await Promise.race([props.onChanged(), new Promise((r) => window.setTimeout(r, 5000))]); } catch { /* 刷新失败就算了，上面的提示照旧 */ }
      setSaving(false);
      return;
    }
    // 保存途中点了 ✕ 关掉：资料存上了，只刷新列表；不再传照片、不回调 onSaved（F05）
    if (cancelledRef.current) { void props.onChanged(); return; }
    const noticeId = id;
    const todo = [...queuedRef.current];
    const r = await uploadQueuedPhotos({
      items: todo,
      existingCount,
      isCancelled: () => cancelledRef.current,
      onProgress: (i, total) => setProgress(`正在传照片 ${i + 1} / ${total}…`),
      upload: async (q) => {
        const img = await compressImageForUpload(q.file);
        const thumb = await makeThumb(img); // G03：画不出来就是 null，照样传原图
        if (cancelledRef.current) return "cancelled"; // 压缩完发现弹窗关了：这张不发
        const res = await uploadArrivalNoticeImage(noticeId, img, thumb);
        setImages(res.item.images);
        unqueue(q.url);
        return { count: res.item.images.length };
      },
    });
    setProgress("");
    if (r.cancelled || cancelledRef.current) { void props.onChanged(); return; }
    if (r.limitReached) {
      setError(photoFailMessage(r, savedNoteRef.current));
      setSaving(false);
      void props.onChanged();
      return;
    }
    if (r.failed > 0) {
      // 资料已经存上了；没传上的照片还留在框里，再点「保存」接着传（不会多登记一条）
      setError(photoFailMessage(r, savedNoteRef.current));
      setSaving(false);
      void props.onChanged();
      return;
    }
    props.onSaved(doneMessage);
  };

  /**
   * 关弹窗前问一句。返回 false = 不关。
   * - 没在保存、框里有待传照片：那几张只在这个弹窗里，关了就没了（dsh 审查 S2）。
   * - 正在保存 / 传照片：原来也说「关掉就没了」，其实照片在后台接着传完、传完还关掉下一个弹窗（F05）。
   *   现在确定关掉就叫停：已经存上的留着，正在传的那一张可能也会传上，其余的不再传。
   */
  const confirmClose = () => {
    const left = queuedRef.current.length;
    if (saving) {
      const ok = window.confirm(left > 0
        ? `正在保存 / 传照片，还有 ${left} 张没传完。\n现在关掉：已经存上的资料和照片会留着，正在传的这一张可能也会传上，其余的不再传。确定关掉吗？`
        : "正在保存。现在关掉的话，这次可能已经存上了（关掉后在列表里看一眼）。确定关掉吗？");
      if (ok) cancelledRef.current = true;
      return ok;
    }
    return left === 0 || window.confirm(`还有 ${left} 张照片没传上，关掉就没了。确定关掉吗？`);
  };
  const close = () => {
    if (savedId && !editing) props.onChanged();
    props.onClose();
  };

  return (
    <DetailModal title={editing ? "修改到货通知" : "登记到货"} subtitle={editing?.trackingNo ?? null} onClose={close} confirmClose={confirmClose} closeOnEsc={false}>
      {editing?.convertedTo === "inbound" ? (
        <p className="an-note">这票货已经转成「待入库」运单，这里保存会同步改那张运单；资料齐了回列表点「转正式运单」。</p>
      ) : null}
      {/* 保存 / 传照片期间整张表锁住（修复第 2 轮）：保存发出去的是点「保存」那一刻的资料，传照片那几十秒里再改的字
          不会存上，传完照样关窗说「已保存」—— 改了等于白改、还没人知道。跟「加照片」「移除」一样，保存中不让动 */}
      <div className="an-form">
        {/* 不用 <label> 包：label 里点下拉的某一行，浏览器会把点击转给输入框，刚选完下拉又弹开 */}
        <div className="an-field">
          <span>唛头</span>
          <MarkPicker disabled={saving} value={draft.clientId} onChange={(v) => set("clientId", v)} options={props.clients} loadFailed={props.clientsFailed} placeholder="输入唛头搜索" />
          {!clientKnown ? <small className="an-warn">系统里没有这个唛头，要选下拉里已有的</small> : null}
          {clientChangedAfterNotify ? <small className="an-warn">这条已标「已通知客户」（通知的是 {savedClient}）。换了唛头，保存后会改回「未通知」，记得通知新客户</small> : null}
        </div>
        <label>
          <span>运单号</span>
          <input disabled={saving} value={draft.trackingNo} onChange={(e) => set("trackingNo", e.target.value)} placeholder="转运单时必须有" />
        </label>
        <label>
          <span>品名</span>
          <input disabled={saving} value={draft.itemName} onChange={(e) => set("itemName", e.target.value)} />
        </label>
        <label>
          <span>件数</span>
          <input disabled={saving} value={draft.packageCount} onChange={(e) => set("packageCount", e.target.value)} inputMode="numeric" />
        </label>
        <label>
          <span>重量（公斤）</span>
          <input disabled={saving} value={draft.weightKg} onChange={(e) => set("weightKg", e.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>体积（立方）</span>
          <input disabled={saving} value={draft.volumeM3} onChange={(e) => set("volumeM3", e.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>运输方式</span>
          <select disabled={saving} value={draft.transportMode} onChange={(e) => set("transportMode", e.target.value as ArrivalNoticeDraft["transportMode"])}>
            <option value="">还没定</option>
            <option value="sea">海运</option>
            <option value="land">陆运</option>
          </select>
        </label>
        <label>
          <span>货型</span>
          <select disabled={saving} value={draft.cargoType} onChange={(e) => set("cargoType", cargoTypeOf(e.target.value))}>
            {CARGO_TYPES.map((c) => <option key={c} value={c}>{CARGO_TYPE_ZH[c]}</option>)}
          </select>
        </label>
        <label>
          <span>仓库</span>
          <select disabled={saving} value={draft.warehouseId} onChange={(e) => set("warehouseId", e.target.value)}>
            <option value="">没选</option>
            {WAREHOUSES.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </label>
        <label>
          <span>到仓日期</span>
          <input disabled={saving} type="date" value={draft.arrivedAt} onChange={(e) => set("arrivedAt", e.target.value)} />
        </label>
        <label>
          <span>国内快递单号</span>
          <input disabled={saving} value={draft.domesticTrackingNo} onChange={(e) => set("domesticTrackingNo", e.target.value)} />
        </label>
        <label className="an-form-wide">
          <span>备注（内部看，不进给客户的文案）</span>
          <textarea disabled={saving} value={draft.remark} onChange={(e) => set("remark", e.target.value)} rows={2} />
        </label>
      </div>

      <div className="an-form-photos">
        <span className="an-form-label">照片（一条最多 {MAX_NOTICE_IMAGES} 张，现在 {images.length + queued.length} 张）</span>
        <div className="an-photos">
          {images.map((img) => (
            <figure key={img.id} className="an-photo">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumbSrc(img)} alt={img.fileName} loading="lazy" decoding="async" />
              <figcaption><button type="button" className="an-link an-link-danger" onClick={() => void removeExisting(img)}>删除</button></figcaption>
            </figure>
          ))}
          {queued.map((q) => (
            <figure key={q.url} className="an-photo is-queued">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={q.url} alt={q.file.name} />
              <figcaption>
                <span className="an-muted">待上传</span>
                <button type="button" className="an-link an-link-danger" disabled={saving} onClick={() => unqueue(q.url)}>移除</button>
              </figcaption>
            </figure>
          ))}
          {slotsLeft > 0
            // 保存 / 传照片途中不许再加：那批是开传时拍的快照，途中加的不会传，传完弹窗一关就丢了（F05）
            ? <button type="button" className="an-photo-add" disabled={saving} onClick={() => fileRef.current?.click()}>＋ 加照片</button>
            : <span className="an-muted">已满 {MAX_NOTICE_IMAGES} 张</span>}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(e.target.files)} />
        </div>
      </div>

      {pickNote ? <p className="an-warn">{pickNote}</p> : null}
      {error ? <p role="alert" className="an-error">{error}</p> : null}
      <div className="an-form-actions">
        {progress ? <span className="an-muted">{progress}</span> : null}
        <button type="button" className="an-btn" onClick={() => { if (confirmClose()) close(); }} disabled={saving}>{savedId && !editing ? "关闭" : "取消"}</button>
        <button type="button" className="an-btn an-btn-primary" onClick={() => void submit()} disabled={saving}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </DetailModal>
  );
}
