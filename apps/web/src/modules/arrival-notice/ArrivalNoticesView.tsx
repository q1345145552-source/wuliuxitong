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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "../../services/arrival-notice-api";
import { buildArrivalNoticeText } from "./notice-text";
import { missingForFormal } from "./missing";
import { copyImage, copyText, saveImage } from "./copy-helpers";

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

function imgSrc(img: ArrivalNoticeImage): string {
  return apiBaseUrl() + img.imageUrl;
}

function emptyDraft(): ArrivalNoticeDraft {
  let warehouseId = "";
  try { warehouseId = window.localStorage.getItem(LAST_WAREHOUSE_KEY) ?? ""; } catch { /* 隐私模式读不了就算了 */ }
  if (!WAREHOUSE_ZH[warehouseId]) warehouseId = "";
  return {
    clientId: "", trackingNo: "", itemName: "", packageCount: "", weightKg: "", volumeM3: "",
    transportMode: "", domesticTrackingNo: "", warehouseId, arrivedAt: beijingToday(), remark: "",
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
    domesticTrackingNo: s(n.domesticTrackingNo),
    warehouseId: n.warehouseId ?? "",
    arrivedAt: s(n.arrivedAt),
    remark: s(n.remark),
  };
}

type Editor = { mode: "new" } | { mode: "edit"; item: ArrivalNotice };

export default function ArrivalNoticesView() {
  const [tab, setTab] = useState<ArrivalNoticeTab>("todo");
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ArrivalNoticePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);
  const [toast, setToast] = useState<{ seq: number; message: string; tone: "success" | "error" }>({ seq: 0, message: "", tone: "success" });
  const [clients, setClients] = useState<string[]>([]);
  const gate = useRef(createRequestGate());

  const say = useCallback((message: string, tone: "success" | "error" = "success") => {
    setToast((t) => ({ seq: t.seq + 1, message, tone }));
  }, []);

  // 搜索框停手 300 毫秒再查，回到第 1 页
  useEffect(() => {
    const t = window.setTimeout(() => { setKeyword(keywordInput.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(t);
  }, [keywordInput]);

  const load = useCallback(async (silent: boolean) => {
    const ticket = gate.current.begin();
    if (!silent) setLoading(true);
    try {
      const res = await fetchArrivalNotices({ tab, keyword, page, pageSize: PAGE_SIZE });
      if (!gate.current.isCurrent(ticket)) return;
      // 删掉 / 转走了最后一页的最后一条：别停在空白页，退回上一页
      if (res.items.length === 0 && page > 1) { setPage((p) => Math.max(1, p - 1)); return; }
      setData(res);
      setLoadError("");
    } catch (e) {
      if (!gate.current.isCurrent(ticket)) return;
      // 悄悄重拉失败：接着显示手上的，不弹错
      if (!silent) setLoadError(e instanceof Error ? e.message : "加载失败");
    } finally {
      if (gate.current.isCurrent(ticket) && !silent) setLoading(false);
    }
  }, [tab, keyword, page]);

  useEffect(() => { void load(false); }, [load]);

  useLiveRefresh({
    topics: ["shipping"],
    refresh: async (isStillWanted) => { if (isStillWanted()) await load(true); },
  });

  useEffect(() => {
    let cancelled = false;
    fetchStaffClients().then((items) => { if (!cancelled) setClients(items.map((c) => c.id)); }).catch(() => { /* 唛头下拉没有也能手输 */ });
    return () => { cancelled = true; };
  }, []);

  const run = async (id: string, work: () => Promise<void>) => {
    setBusyId(id);
    try { await work(); } catch (e) { say(e instanceof Error ? e.message : "操作失败", "error"); }
    finally { setBusyId(null); }
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
    await setArrivalNoticeNotified(n.id, !n.notifiedAt);
    say(n.notifiedAt ? "已改回「未通知」" : "已标为「已通知客户」");
    await load(true);
  });

  const onConvert = (n: ArrivalNotice, to: "formal" | "inbound") => {
    const ask = to === "formal"
      ? `把 ${n.trackingNo ?? "这票货"} 转成正式运单（状态「已入库」）？\n转完这条到货通知就只能看、不能改了。`
      : `把 ${n.trackingNo ?? "这票货"} 转成「待入库」运单？\n客户在「运单查询」里会看到「待入库」；资料补全后回这里点「转正式运单」。`;
    if (!window.confirm(ask)) return;
    void run(n.id, async () => {
      await convertArrivalNotice(n.id, to);
      say(to === "formal" ? "已转成正式运单，「运单管理」里能看到" : "已转成待入库，资料补全后点「转正式运单」");
      await load(true);
    });
  };

  const onDelete = (n: ArrivalNotice) => {
    if (!window.confirm(`删除这条到货通知${n.trackingNo ? `（${n.trackingNo}）` : ""}？照片一起删，删了找不回来。`)) return;
    void run(n.id, async () => {
      await deleteArrivalNotice(n.id);
      say("已删除");
      await load(true);
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
          <button type="button" className="an-btn an-btn-primary" onClick={() => setEditor({ mode: "new" })}>＋ 登记到货</button>
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
            busy={busyId === n.id}
            imageBusyId={busyId}
            onCopyText={() => void onCopyText(n)}
            onCopyImage={(img) => void onCopyImage(img)}
            onSaveImage={(img) => void onSaveImage(img)}
            onPreview={(img) => setPreview({ src: imgSrc(img), alt: img.fileName })}
            onToggleNotified={() => void onToggleNotified(n)}
            onEdit={() => setEditor({ mode: "edit", item: n })}
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
          editor={editor}
          clients={clients}
          onClose={() => setEditor(null)}
          onSaved={(message) => { setEditor(null); say(message); void load(true); }}
          onChanged={() => load(true)}
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
  imageBusyId: string | null;
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
  const meta: Array<[string, string]> = [
    ["运单号", n.trackingNo ?? ""],
    ["品名", n.itemName ?? ""],
    ["重量", n.weightKg !== null ? `${n.weightKg} kg` : ""],
    ["体积", n.volumeM3 !== null ? `${n.volumeM3} m³` : ""],
    ["运输方式", mode],
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imgSrc(img)} alt={img.fileName} onClick={() => props.onPreview(img)} />
              <figcaption>
                <button type="button" className="an-link" onClick={() => props.onCopyImage(img)}>复制</button>
                <button type="button" className="an-link" disabled={props.imageBusyId === img.id} onClick={() => props.onSaveImage(img)}>保存</button>
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
      {!formal && missing.length > 0 ? (
        <p className="an-missing">转正式运单还缺：{missing.join("、")}{inbound || missing.includes("运单号") || missing.includes("唛头") ? "" : "（可以先转待入库）"}</p>
      ) : null}

      <footer className="an-actions">
        <span className="an-who">{n.createdByName ? `${n.createdByName} ` : ""}登记于 {shortTime(n.createdAt)}</span>
        <button type="button" className="an-btn" disabled={busy} onClick={props.onToggleNotified}>{n.notifiedAt ? "改回未通知" : "标为已通知客户"}</button>
        {!formal ? <button type="button" className="an-btn" disabled={busy} onClick={props.onEdit}>修改</button> : null}
        {!formal ? <button type="button" className="an-btn an-btn-go" disabled={busy} onClick={() => props.onConvert("formal")}>转正式运单</button> : null}
        {!formal && !inbound ? <button type="button" className="an-btn" disabled={busy} onClick={() => props.onConvert("inbound")}>转待入库</button> : null}
        {(formal || inbound) && n.trackingNo ? (
          <button type="button" className="an-btn" onClick={() => openShipmentTrack({ trackingNo: n.trackingNo! })}>物流轨迹</button>
        ) : null}
        {!formal && !inbound ? <button type="button" className="an-btn an-btn-danger" disabled={busy} onClick={props.onDelete}>删除</button> : null}
      </footer>
    </article>
  );
}

function NoticeEditor(props: {
  editor: Editor;
  clients: string[];
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
  const [queued, setQueued] = useState<Array<{ file: File; url: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const queuedRef = useRef(queued);
  queuedRef.current = queued;

  // 关掉弹窗时把还没传的预览图放掉（移除 / 传完的那一张当场放）
  useEffect(() => () => { queuedRef.current.forEach((q) => URL.revokeObjectURL(q.url)); }, []);

  const set = <K extends keyof ArrivalNoticeDraft>(k: K, v: ArrivalNoticeDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const clientKnown = !draft.clientId || props.clients.length === 0 || props.clients.includes(draft.clientId);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const picked = Array.from(files).filter((f) => f.type.startsWith("image/"));
    setQueued((q) => [...q, ...picked.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
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
    try {
      const { item } = await saveArrivalNotice(id, draft, base);
      id = item.id;
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
      try { await props.onChanged(); } catch { /* 刷新失败就算了，上面的提示照旧 */ }
      setSaving(false);
      return;
    }
    const todo = [...queuedRef.current];
    let failedPhotos = 0;
    for (let i = 0; i < todo.length; i++) {
      setProgress(`正在传照片 ${i + 1} / ${todo.length}…`);
      try {
        const r = await uploadArrivalNoticeImage(id, await compressImageForUpload(todo[i].file));
        setImages(r.item.images);
        unqueue(todo[i].url);
      } catch (e) {
        failedPhotos += 1;
        if (failedPhotos === 1) setError(e instanceof Error ? e.message : "照片没传上");
      }
    }
    setProgress("");
    if (failedPhotos > 0) {
      // 资料已经存上了；没传上的照片还留在框里，再点「保存」接着传（不会多登记一条）
      setError((prev) => `资料已保存，但有 ${failedPhotos} 张照片没传上（${prev}），再点「保存」接着传`);
      setSaving(false);
      props.onChanged();
      return;
    }
    props.onSaved(editing ? "已保存" : "已登记，可以复制文案通知客户了");
  };

  /** 还有照片没传上就关：先问一句（那几张只在这个弹窗里，关了就没了 —— dsh 审查 S2）。返回 false = 不关 */
  const confirmClose = () =>
    queuedRef.current.length === 0 || window.confirm(`还有 ${queuedRef.current.length} 张照片没传上，关掉就没了。确定关掉吗？`);
  const close = () => {
    if (savedId && !editing) props.onChanged();
    props.onClose();
  };

  return (
    <DetailModal title={editing ? "修改到货通知" : "登记到货"} subtitle={editing?.trackingNo ?? null} onClose={close} confirmClose={confirmClose} closeOnEsc={false}>
      {editing?.convertedTo === "inbound" ? (
        <p className="an-note">这票货已经转成「待入库」运单，这里保存会同步改那张运单；资料齐了回列表点「转正式运单」。</p>
      ) : null}
      <div className="an-form">
        <label>
          <span>唛头</span>
          <input value={draft.clientId} onChange={(e) => set("clientId", e.target.value)} list="an-client-options" autoComplete="off" placeholder="搜索唛头…" />
          {!clientKnown ? <small className="an-warn">系统里没有这个唛头，要选下拉里已有的</small> : null}
          <datalist id="an-client-options">
            {props.clients.filter((c) => !draft.clientId || c.toLowerCase().includes(draft.clientId.toLowerCase())).slice(0, 50).map((c) => <option key={c} value={c} />)}
          </datalist>
        </label>
        <label>
          <span>运单号</span>
          <input value={draft.trackingNo} onChange={(e) => set("trackingNo", e.target.value)} placeholder="转运单时必须有" />
        </label>
        <label>
          <span>品名</span>
          <input value={draft.itemName} onChange={(e) => set("itemName", e.target.value)} />
        </label>
        <label>
          <span>件数</span>
          <input value={draft.packageCount} onChange={(e) => set("packageCount", e.target.value)} inputMode="numeric" />
        </label>
        <label>
          <span>重量（公斤）</span>
          <input value={draft.weightKg} onChange={(e) => set("weightKg", e.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>体积（立方）</span>
          <input value={draft.volumeM3} onChange={(e) => set("volumeM3", e.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>运输方式</span>
          <select value={draft.transportMode} onChange={(e) => set("transportMode", e.target.value as ArrivalNoticeDraft["transportMode"])}>
            <option value="">还没定</option>
            <option value="sea">海运</option>
            <option value="land">陆运</option>
          </select>
        </label>
        <label>
          <span>仓库</span>
          <select value={draft.warehouseId} onChange={(e) => set("warehouseId", e.target.value)}>
            <option value="">没选</option>
            {WAREHOUSES.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </label>
        <label>
          <span>到仓日期</span>
          <input type="date" value={draft.arrivedAt} onChange={(e) => set("arrivedAt", e.target.value)} />
        </label>
        <label>
          <span>国内快递单号</span>
          <input value={draft.domesticTrackingNo} onChange={(e) => set("domesticTrackingNo", e.target.value)} />
        </label>
        <label className="an-form-wide">
          <span>备注（内部看，不进给客户的文案）</span>
          <textarea value={draft.remark} onChange={(e) => set("remark", e.target.value)} rows={2} />
        </label>
      </div>

      <div className="an-form-photos">
        <span className="an-form-label">照片</span>
        <div className="an-photos">
          {images.map((img) => (
            <figure key={img.id} className="an-photo">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imgSrc(img)} alt={img.fileName} />
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
          <button type="button" className="an-photo-add" onClick={() => fileRef.current?.click()}>＋ 加照片</button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(e.target.files)} />
        </div>
      </div>

      {error ? <p role="alert" className="an-error">{error}</p> : null}
      <div className="an-form-actions">
        {progress ? <span className="an-muted">{progress}</span> : null}
        <button type="button" className="an-btn" onClick={() => { if (confirmClose()) close(); }} disabled={saving}>{savedId && !editing ? "关闭" : "取消"}</button>
        <button type="button" className="an-btn an-btn-primary" onClick={() => void submit()} disabled={saving}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </DetailModal>
  );
}
