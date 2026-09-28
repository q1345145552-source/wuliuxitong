"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiBaseUrl, apiRequest } from "../../services/core-api";
import { createRequestGate } from "../../modules/shared/request-gate";
import { getOptionalSession } from "../../auth/auth-session";
import { useCurrentSessionBrand } from "../../modules/branding/useWorkbenchBrand";
import DetailModal from "../../modules/layout/DetailModal";
import { formatBeijingTime } from "../../modules/staff/utils";
import { beijingDate } from "../../modules/shared/beijing-date";

/* 2026-08-31（Codex 二轮）：列表接口不再下发 certFileBase64 / productImages 大字段
   （表格根本不显示它们），remark 客户角色也拿不到了——类型跟着后端同步。
   大字段要看的话走 /client/fcl-inquiries/detail?id= 按条取。 */
type FclInquiryItem = {
  id: string; clientId: string; productName: string;
  cargoValue: string; cargoWeight: string; address: string;
  containerType: string; serviceType: string; loadingDate: string | null;
  certFileName: string | null;
  // createdByRole：只有超级管理员拿得到（2026-09-15），客户和员工的接口返回里没有
  status: string; remark?: string | null; createdByRole?: string;
  createdAt: string;
  /* ↓ 2026-09-28 报价 / 转整柜（后端 fcl-inquiries/routes.ts 的 quoteFields，逐字段对齐）。
     status：pending 待处理 / quoted 已报价 / accepted 客户已接受 / converted 已转整柜 */
  quoteAmountCny: number | null;
  quoteNote: string | null;
  quotedAt: string | null;
  acceptedAt: string | null;
  convertedAt: string | null;
  /** 员工 / 超管才有：转成的整柜（柜子 id） */
  fclContainerId?: string | null;
  /** 员工 / 超管才有：转过的整柜后来被删了，可以重新转 */
  fclDeleted?: boolean;
};

type FclInquiryDetail = FclInquiryItem & {
  certFileBase64: string | null;
  productImages: Array<{ fileName?: string; base64?: string }>;
};

/** 状态显示。客户那边「已报价」多一句提示他去点接受 */
export function inquiryStatusLabel(status: string, forClient: boolean): string {
  switch (status) {
    case "pending": return "待报价";
    case "quoted": return forClient ? "已报价，等你确认" : "已报价，等客户确认";
    case "accepted": return forClient ? "已接受报价" : "客户已接受";
    case "converted": return "已转整柜";
    case "processing": return "处理中";
    case "completed": return "完成";
    default: return status;
  }
}

const money = (n: number | null) => (n == null ? "—" : `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
const statusColor = (status: string) =>
  status === "quoted" ? "var(--c-amber-deep)" : status === "accepted" ? "var(--c-green-deep)" : status === "converted" ? "var(--c-blue-deep)" : "var(--t-muted)";

export type ClientFclInquiryProps = {
  visible: boolean;
  clients?: Array<{ id: string; name: string }>; // staff端用
  isStaff?: boolean;
  onToast: (msg: string) => void;
};

export default function FclInquiryPanel(props: ClientFclInquiryProps) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [list, setList] = useState<FclInquiryItem[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState(false);
  // 2026-08-31（Codex 二轮）：列表改后端翻页（照客户预报单列表的写法），共 N 条用后端 total
  const [listPage, setListPage] = useState(1);
  const [listTotal, setListTotal] = useState(0);
  const listPageSize = 50;

  // 表单
  const [productName, setProductName] = useState("");
  const [cargoValue, setCargoValue] = useState("");
  const [cargoWeight, setCargoWeight] = useState("");
  const [address, setAddress] = useState("");
  const [containerType, setContainerType] = useState("1*40HQ");
  const [serviceType, setServiceType] = useState("清提派");
  const [loadingDate, setLoadingDate] = useState("");
  const [certFile, setCertFile] = useState<File | null>(null);
  const [productImageFiles, setProductImageFiles] = useState<File[]>([]);
  const [productPreviews, setProductPreviews] = useState<string[]>([]);
  const [selectedClientId, setSelectedClientId] = useState("");

  // 2026-09-01 竞态全扫：列表自己的门闩——快速翻页/提交后刷新时只认最新一次请求，
  // 晚到的旧页不许盖新页，页码也只在数据验号通过后才跟着更新
  const listGate = useRef(createRequestGate()).current;

  // ↓ 2026-09-28 报价 / 接受 / 转整柜
  const brand = useCurrentSessionBrand();
  const [accepting, setAccepting] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FclInquiryDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [quoteAmount, setQuoteAmount] = useState("");
  const [quoteNote, setQuoteNote] = useState("");
  /** 正在保存报价的询价单（按单号记）：同一张单上一次报价还没回来，不许再报（2026-09-28 分支审查 Codex 复看第 3 条） */
  const [savingQuoteIds, setSavingQuoteIds] = useState<string[]>([]);
  const savingQuoteIdsRef = useRef(new Set<string>());
  const [quoteMessage, setQuoteMessage] = useState("");
  /** 每打开 / 关掉一次详情就加一：同一张单关了又开，前一次晚到的响应也认得出是旧的（Codex 复核第 12 条） */
  const detailSeqRef = useRef(0);
  const closeDetail = () => { detailSeqRef.current += 1; setDetailId(null); };
  /** 当前在第几页：报价晚回来时刷新的是「现在这一页」，不是点报价那会儿的那一页（Codex 复看第 9 条） */
  const listPageRef = useRef(listPage);
  listPageRef.current = listPage;

  const loadList = async (page = listPage) => {
    const ticket = listGate.begin(); // 2026-09-01 竞态全扫：出发时领号
    try {
      // 2026-08-31（Codex 二轮）：带上 page/pageSize，接口只回当前页 + 真实总数
      const data = await apiRequest<{ items: FclInquiryItem[]; total?: number }>(
        `${apiBaseUrl()}/client/fcl-inquiries?page=${page}&pageSize=${listPageSize}`
      );
      if (!listGate.isCurrent(ticket)) return; // 2026-09-01 竞态全扫：号作废——数据、页码、错误态都不许碰
      setList(data.items ?? []); // 【审查问题 13】接口少了 items 就会让整页崩掉
      setListTotal(data.total ?? (data.items ?? []).length);
      setListPage(page); // 页码跟数据同一批更新，不再出现「页码是新的、数据是旧的」
      setListError(false);
      setListLoaded(true);
    } catch (e: any) {
      if (!listGate.isCurrent(ticket)) return; // 2026-09-01 竞态全扫：旧请求的报错不许安到新请求头上
      props.onToast("加载询价记录失败：" + (e.message || "网络错误"));
      setListError(true);
      setListLoaded(true);
    }
  };

  /** 员工：打开询价单详情（全部信息 + 报价 + 转整柜 + 联系客户） */
  const openDetail = async (id: string) => {
    const seq = ++detailSeqRef.current;
    setDetailId(id);
    setDetail(null);
    setDetailError("");
    setQuoteMessage("");
    try {
      const d = await apiRequest<FclInquiryDetail>(`${apiBaseUrl()}/client/fcl-inquiries/detail?id=${encodeURIComponent(id)}`);
      if (detailSeqRef.current !== seq) return; // 已经换了一张 / 关掉了 / 关了又开（这份是旧的）
      setDetail(d);
      setQuoteAmount(d.quoteAmountCny == null ? "" : String(d.quoteAmountCny));
      setQuoteNote(d.quoteNote ?? "");
    } catch (e: any) {
      if (detailSeqRef.current !== seq) return;
      setDetailError(e?.message || "加载失败");
    }
  };

  const saveQuote = async () => {
    if (!detail) return;
    const id = detail.id;
    /* 同一张单上一次报价还没回来：不许再报。原来关了又打开同一张就能再点，两次请求谁先到库说不准，
       晚到的旧价会盖掉新价（还会清掉客户对新价的「已接受」） */
    if (savingQuoteIdsRef.current.has(id)) { setQuoteMessage("这张单上一次报价还在保存，等它回来再改"); return; }
    if (!quoteAmount.trim()) { setQuoteMessage("请填报价金额"); return; }
    /* 认「这一次打开的详情」而不是认单号（2026-09-28 分支审查）：原来只比单号 ——
       ① 报价还没回来就关了 / 换了一张：保存成功也不刷新列表、不提示；失败了更是什么都不说；
       ② 关了又打开同一张、刚填了新金额，旧那次保存回来会重新加载详情，把新填的冲掉。
       现在：成败都给提示、列表总是刷新；只有详情还是出发时那一次打开的，才重新加载详情。 */
    const seq = detailSeqRef.current;
    const wasQuoted = Boolean(detail.quotedAt);
    savingQuoteIdsRef.current.add(id);
    setSavingQuoteIds([...savingQuoteIdsRef.current]);
    setQuoteMessage("");
    try {
      await apiRequest(`${apiBaseUrl()}/staff/fcl-inquiries/quote`, {
        method: "POST",
        body: JSON.stringify({ id, amountCny: quoteAmount.trim(), note: quoteNote.trim() }),
      });
      props.onToast(wasQuoted ? "报价已修改，客户要重新点「接受」" : "已报价，客户在「整柜询价」里能看到");
      loadList(listPageRef.current);
      if (detailSeqRef.current === seq) await openDetail(id);
    } catch (e: any) {
      const msg = `报价没保存：${e?.message || "请重试"}`;
      if (detailSeqRef.current === seq) setQuoteMessage(msg);
      else props.onToast(msg);
    } finally {
      savingQuoteIdsRef.current.delete(id);
      setSavingQuoteIds([...savingQuoteIdsRef.current]);
    }
  };

  /** 客户：接受报价。带上看到的报价时间，客服刚好改了价就会被拒、提示刷新 */
  const acceptQuote = async (item: FclInquiryItem) => {
    if (accepting || !item.quotedAt || item.quoteAmountCny == null) return;
    if (!window.confirm(`确认接受 ${money(item.quoteAmountCny)} 的报价？\n（付款还是线下跟客服对接）`)) return;
    setAccepting(item.id);
    try {
      await apiRequest(`${apiBaseUrl()}/client/fcl-inquiries/accept`, {
        method: "POST",
        body: JSON.stringify({ id: item.id, quotedAt: item.quotedAt }),
      });
      props.onToast("已接受报价，客服会跟你安排装柜");
    } catch (e: any) {
      props.onToast(`没接受成功：${e?.message || "请刷新后重试"}`);
    } finally {
      setAccepting(null);
      loadList(listPage);
    }
  };

  /** 转整柜：去「整柜管理」建整柜，表单按这张询价单预填（柜号、提单号那些装完柜才有，员工手填） */
  const convertHref = (id: string) => {
    const role = getOptionalSession()?.role;
    return `${role === "admin" ? "/admin/fcl-containers" : "/staff/fcl-containers"}?fromInquiry=${encodeURIComponent(id)}`;
  };

  /* 2026-09-29 老板：「询价记录每次都要点加载才能出来」—— 7-03 做这个面板起，列表只放了个「加载记录」按钮，从不自己加载。
     现在每次切到「整柜询价」就自己拉当前这一页；切走再切回来也重拉（客户新提交的询价不用刷新整页就能看到）。
     面板在页面上一直挂着、只是藏起来（visible=false），所以按 visible 触发、不在挂载时拉：没打开这一栏就不发请求。 */
  useEffect(() => {
    if (props.visible) void loadList(listPageRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  if (!props.visible) return null;

  const readAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1] || "");
      reader.onerror = () => reject(new Error("读取失败"));
      reader.readAsDataURL(file);
    });

  const submit = async () => {
    if (!productName.trim()) { setMessage("请填写品名"); return; }
    if (!address.trim()) { setMessage("请填写地址"); return; }
    if (props.isStaff && !selectedClientId.trim()) { setMessage("请选择客户"); return; }
    setLoading(true); setMessage("");
    try {
      let certFileBase64 = "";
      if (certFile) certFileBase64 = await readAsBase64(certFile);
      let productImagesJson = "";
      if (productImageFiles.length > 0) {
        const imgs = await Promise.all(
          productImageFiles.map(async (f) => ({ fileName: f.name, base64: await readAsBase64(f) }))
        );
        productImagesJson = JSON.stringify(imgs);
      }
      const body: any = {
        productName: productName.trim(),
        cargoValue: cargoValue.trim(),
        cargoWeight: cargoWeight.trim(),
        address: address.trim(),
        containerType,
        serviceType,
        loadingDate: loadingDate || undefined,
        certFileName: certFile?.name || undefined,
        certFileBase64: certFileBase64 || undefined,
        productImages: productImagesJson || undefined,
      };
      if (props.isStaff) body.clientId = selectedClientId.trim();

      const endpoint = props.isStaff ? "/staff/fcl-inquiries" : "/client/fcl-inquiries";
      await apiRequest(apiBaseUrl() + endpoint, {
        method: "POST",
        body: JSON.stringify(body),
      });
      props.onToast("整柜询价已提交");
      // 清空表单
      setProductName(""); setCargoValue(""); setCargoWeight(""); setAddress("");
      setContainerType("1*40HQ"); setServiceType("清提派"); setLoadingDate("");
      setCertFile(null); setProductImageFiles([]); setProductPreviews([]);
      setSelectedClientId("");
      loadList(1); // 2026-08-31（Codex 二轮）：新提交的排最前，回第 1 页才看得见
    } catch (e: any) {
      setMessage(e.message || "提交失败");
    } finally {
      setLoading(false);
    }
  };

  const handleProductImages = (files: FileList | null) => {
    if (!files) return;
    const arr = Array.from(files);
    setProductImageFiles((prev) => [...prev, ...arr]);
    arr.forEach((f) => {
      const reader = new FileReader();
      reader.onload = () => setProductPreviews((p) => [...p, reader.result as string]);
      reader.readAsDataURL(f);
    });
  };

  return (
    <section style={{ border: "1px solid var(--l-soft)", borderRadius: 12, padding: 20, background: "var(--white)", marginBottom: 18 }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>整柜询价</h2>

      {/* 表单。2026-09-01 竞态全扫：提交期间整个表单加 disabled 上锁——
          否则提交 A 的等待期里用户接着填 B，A 成功后的「清空表单」会把 B 的输入整个抹掉 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, maxWidth: 700, marginBottom: 20 }}>
        {props.isStaff && (
          <div style={{ gridColumn: "1/-1" }}>
            <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>选择客户 *</label>
            <input disabled={loading} value={selectedClientId} onChange={e => setSelectedClientId(e.target.value)} placeholder="输入客户ID" list="fcl-client-list"
              style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
            <datalist id="fcl-client-list">
              {(props.clients ?? []).map(c => (<option key={c.id} value={c.id} />))}
            </datalist>
          </div>
        )}
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>品名 *</label>
          <input disabled={loading} value={productName} onChange={e => setProductName(e.target.value)} placeholder="货物品名"
            style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>货值</label>
          <input disabled={loading} value={cargoValue} onChange={e => setCargoValue(e.target.value)} placeholder="如 ¥50,000"
            style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>货重</label>
          <input disabled={loading} value={cargoWeight} onChange={e => setCargoWeight(e.target.value)} placeholder="如 25吨"
            style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>地址 *</label>
          <input disabled={loading} value={address} onChange={e => setAddress(e.target.value)} placeholder="收货/发货地址"
            style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>柜型</label>
          <select disabled={loading} value={containerType} onChange={e => setContainerType(e.target.value)}
            style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }}>
            <option value="1*40HQ">1*40HQ</option>
            <option value="1*20GP">1*20GP</option>
            <option value="2*40HQ">2*40HQ</option>
            <option value="1*40GP">1*40GP</option>
            <option value="其他">其他</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>清提派/派送</label>
          <select disabled={loading} value={serviceType} onChange={e => setServiceType(e.target.value)}
            style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }}>
            <option value="清提派">清提派（清关+提货+派送）</option>
            <option value="派送">仅派送</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>装柜时间</label>
          <input disabled={loading} type="date" value={loadingDate} onChange={e => setLoadingDate(e.target.value)}
            style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>认证文件</label>
          <input disabled={loading} type="file" onChange={e => setCertFile(e.target.files?.[0] || null)}
            style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
        </div>
        <div style={{ gridColumn: "1/-1" }}>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>产品图片</label>
          <input disabled={loading} type="file" multiple accept="image/*" onChange={e => handleProductImages(e.target.files)}
            style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13, marginBottom: 8 }} />
          {productPreviews.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {productPreviews.map((src, i) => (
                <img key={i} src={src} alt={`preview-${i}`} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 6, border: "1px solid var(--l-soft)" }} />
              ))}
            </div>
          )}
        </div>
      </div>

      {message && <p style={{ color: message.includes("失败") ? "var(--c-red-deep)" : "var(--c-green-deep)", fontSize: 13, marginBottom: 12 }}>{message}</p>}

      <button disabled={loading} onClick={submit}
        style={{ border: "none", borderRadius: 6, padding: "8px 20px", background: loading ? "var(--t-faint)" : "var(--c-blue)", color: "var(--white)", fontSize: 14, cursor: "pointer", marginBottom: 24 }}>
        {loading ? "提交中…" : "提交询价"}
      </button>

      {/* 历史列表 */}
      <h3 style={{ fontSize: 15, marginBottom: 10 }}>询价记录</h3>
      {!listLoaded && <p style={{ color: "var(--t-faint)", fontSize: 13 }}>加载中…</p>}
      {/* 2026-09-29：原来点「重试」只是把状态退回「没加载」，还得再点一次「加载记录」才真去拉 —— 现在点一下就重拉当前页 */}
      {listLoaded && listError && <button onClick={() => loadList(listPageRef.current)} style={{ border: "1px solid #fca5a5", borderRadius: 6, padding: "6px 14px", background: "var(--white)", color: "var(--c-red-2)", cursor: "pointer", fontSize: 13 }}>加载失败，点击重试</button>}
      {listLoaded && !listError && list.length === 0 && <p style={{ color: "var(--t-faint)", fontSize: 13 }}>暂无询价记录</p>}
      {/* 2026-08-31（Codex 二轮）：后端翻页，共 N 条用后端 total（照客户预报单列表的写法） */}
      {listLoaded && !listError && listTotal > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: "var(--t-strong)" }}>共 {listTotal} 条 · 第 {listPage}/{Math.max(1, Math.ceil(listTotal / listPageSize))} 页</span>
          <button type="button" onClick={() => loadList(Math.max(1, listPage - 1))} disabled={listPage <= 1}
            style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 12px", background: listPage <= 1 ? "var(--s-sunken)" : "var(--white)", color: listPage <= 1 ? "var(--t-faint)" : "var(--t-heading)", cursor: listPage <= 1 ? "default" : "pointer", fontSize: 12 }}>上一页</button>
          <button type="button" onClick={() => loadList(Math.min(Math.max(1, Math.ceil(listTotal / listPageSize)), listPage + 1))} disabled={listPage >= Math.max(1, Math.ceil(listTotal / listPageSize))}
            style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 12px", background: listPage >= Math.max(1, Math.ceil(listTotal / listPageSize)) ? "var(--s-sunken)" : "var(--white)", color: listPage >= Math.max(1, Math.ceil(listTotal / listPageSize)) ? "var(--t-faint)" : "var(--t-heading)", cursor: listPage >= Math.max(1, Math.ceil(listTotal / listPageSize)) ? "default" : "pointer", fontSize: 12 }}>下一页</button>
        </div>
      )}
      {list.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr style={{ borderBottom: "2px solid var(--l-soft)", textAlign: "left" }}>
              {props.isStaff && <th style={{ padding: "6px 8px" }}>唛头</th>}
              <th style={{ padding: "6px 8px" }}>品名</th>
              <th style={{ padding: "6px 8px" }}>柜型</th>
              <th style={{ padding: "6px 8px" }}>货重</th>
              <th style={{ padding: "6px 8px" }}>服务</th>
              <th style={{ padding: "6px 8px" }}>装柜时间</th>
              <th style={{ padding: "6px 8px" }}>报价</th>
              <th style={{ padding: "6px 8px" }}>状态</th>
              <th style={{ padding: "6px 8px" }}>提交时间</th>
              <th style={{ padding: "6px 8px" }}>操作</th>
            </tr></thead>
            <tbody>
              {list.map((item) => (
                <tr key={item.id} style={{ borderBottom: "1px solid var(--s-cool-2)" }}>
                  {props.isStaff && <td style={{ padding: "6px 8px", fontFamily: "monospace", fontWeight: 600 }}>{item.clientId}</td>}
                  <td style={{ padding: "6px 8px" }}>{item.productName}</td>
                  <td style={{ padding: "6px 8px" }}>{item.containerType}</td>
                  <td style={{ padding: "6px 8px" }}>{item.cargoWeight || "—"}</td>
                  <td style={{ padding: "6px 8px" }}>{item.serviceType}</td>
                  <td style={{ padding: "6px 8px" }}>{item.loadingDate || "—"}</td>
                  <td style={{ padding: "6px 8px", maxWidth: 220 }}>
                    <div style={{ fontWeight: item.quoteAmountCny == null ? 400 : 600 }}>{money(item.quoteAmountCny)}</div>
                    {item.quoteNote ? <div style={{ fontSize: 11, color: "var(--t-muted)", whiteSpace: "pre-wrap" }}>{item.quoteNote}</div> : null}
                  </td>
                  <td style={{ padding: "6px 8px", color: statusColor(item.status), fontWeight: 600 }}>
                    {inquiryStatusLabel(item.status, !props.isStaff)}
                    {props.isStaff && item.fclDeleted ? <div style={{ fontSize: 11, color: "var(--c-red-deep)", fontWeight: 400 }}>转的整柜已被删，可重新转</div> : null}
                  </td>
                  <td style={{ padding: "6px 8px", fontSize: 11 }}>{beijingDate(item.createdAt)}</td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                    {props.isStaff ? (
                      <button type="button" onClick={() => void openDetail(item.id)}
                        style={{ border: "1px solid var(--c-blue)", color: "var(--c-blue)", background: "var(--white)", borderRadius: 6, padding: "3px 10px", fontSize: 12, cursor: "pointer" }}>
                        详情 / 报价
                      </button>
                    ) : item.status === "quoted" ? (
                      <button type="button" disabled={accepting === item.id} onClick={() => void acceptQuote(item)}
                        style={{ border: "none", color: "var(--white)", background: "var(--c-green-3)", borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                        {accepting === item.id ? "提交中…" : "接受报价"}
                      </button>
                    ) : item.status === "converted" ? (
                      <Link href="/client/fcl-containers" style={{ color: "var(--c-blue)", fontSize: 12 }}>去「我的整柜」看</Link>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* 还价在对话里谈（老板 2026-09-28）；代理名下的客户没有对话功能，不给这句 */}
      {!props.isStaff && brand === null && list.some((x) => x.status === "quoted") ? (
        <p style={{ fontSize: 12, color: "var(--t-muted)", marginTop: 8 }}>
          对报价有疑问？点左边「<Link href="/client/chat" style={{ color: "var(--c-blue)" }}>在线客服</Link>」跟客服谈，谈好后客服会改报价，你再点「接受报价」。
        </p>
      ) : null}

      {props.isStaff && detailId ? (
        <DetailModal title="整柜询价详情" subtitle={detail ? `唛头 ${detail.clientId}` : undefined} onClose={closeDetail} closeOnEsc={false}>
          {detailError ? <p style={{ color: "var(--c-red-deep)" }}>没加载出来：{detailError}</p> : null}
          {!detail && !detailError ? <p style={{ color: "var(--t-faint)" }}>加载中…</p> : null}
          {detail ? (
            <div style={{ display: "grid", gap: 16, fontSize: 13 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                {([
                  ["客户唛头", detail.clientId],
                  ["品名", detail.productName],
                  ["货值", detail.cargoValue || "—"],
                  ["货重", detail.cargoWeight || "—"],
                  ["柜型", detail.containerType],
                  ["服务", detail.serviceType],
                  ["装柜时间", detail.loadingDate || "—"],
                  ["提交时间", formatBeijingTime(detail.createdAt)],
                ] as const).map(([k, v]) => (
                  <div key={k}><div style={{ fontSize: 11, color: "var(--t-muted)" }}>{k}</div><div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{v}</div></div>
                ))}
                <div style={{ gridColumn: "1/-1" }}><div style={{ fontSize: 11, color: "var(--t-muted)" }}>地址</div><div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{detail.address}</div></div>
              </div>

              {detail.certFileBase64 || (detail.productImages ?? []).length > 0 ? (
                <div style={{ display: "grid", gap: 8 }}>
                  {detail.certFileBase64 ? (
                    <div>
                      <span style={{ fontSize: 11, color: "var(--t-muted)" }}>认证文件：</span>
                      <a href={`data:application/octet-stream;base64,${detail.certFileBase64}`} download={detail.certFileName || "认证文件"} style={{ color: "var(--c-blue)" }}>
                        {detail.certFileName || "下载"}
                      </a>
                    </div>
                  ) : null}
                  {(detail.productImages ?? []).length > 0 ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {(detail.productImages ?? []).filter((img) => img?.base64).map((img, i) => (
                        <a key={i} href={`data:image/jpeg;base64,${img.base64}`} target="_blank" rel="noreferrer" title={img.fileName || "产品图片"}>
                          <img src={`data:image/jpeg;base64,${img.base64}`} alt={img.fileName || `产品图片 ${i + 1}`} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6, border: "1px solid var(--l-soft)" }} />
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div style={{ border: "1px solid var(--l-soft)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 600 }}>
                  报价
                  <span style={{ marginLeft: 8, color: statusColor(detail.status), fontWeight: 600 }}>{inquiryStatusLabel(detail.status, false)}</span>
                </div>
                {detail.quotedAt ? (
                  <div style={{ color: "var(--t-muted)" }}>
                    当前报价 {money(detail.quoteAmountCny)}{detail.quoteNote ? `（${detail.quoteNote}）` : ""}
                    {` · ${formatBeijingTime(detail.quotedAt)} 报的`}
                    {detail.acceptedAt ? ` · 客户 ${formatBeijingTime(detail.acceptedAt)} 接受` : " · 等客户点接受"}
                  </div>
                ) : null}
                {detail.status === "converted" ? (
                  <div style={{ color: "var(--t-muted)" }}>已经转成整柜，报价不能再改（金额去「整柜管理」里改）。</div>
                ) : (
                  <>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <label style={{ fontSize: 12 }}>金额 ¥
                        <input value={quoteAmount} onChange={(e) => setQuoteAmount(e.target.value)} inputMode="decimal" placeholder="如 18000"
                          style={{ marginLeft: 6, width: 140, border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", fontSize: 13 }} />
                      </label>
                      <input value={quoteNote} onChange={(e) => setQuoteNote(e.target.value)} maxLength={500} placeholder="说明（可选，客户看得到），如：含清关、不含派送"
                        style={{ flex: 1, minWidth: 200, border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", fontSize: 13 }} />
                      <button type="button" disabled={savingQuoteIds.includes(detail.id)} onClick={() => void saveQuote()}
                        style={{ border: "none", borderRadius: 6, background: "var(--c-blue)", color: "var(--white)", padding: "7px 16px", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>
                        {savingQuoteIds.includes(detail.id) ? "保存中…" : detail.quotedAt ? "改报价" : "报价"}
                      </button>
                    </div>
                    {detail.acceptedAt ? <div style={{ fontSize: 12, color: "var(--c-amber-deep)" }}>客户已经接受了现在这个价；改价后客户要重新点「接受」。</div> : null}
                  </>
                )}
                {quoteMessage ? <div role="alert" style={{ color: "var(--c-red-deep)", fontSize: 12 }}>{quoteMessage}</div> : null}
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                {detail.status === "converted" && detail.fclContainerId ? (
                  <Link href={convertHref(detail.id).replace(/\?.*$/, "")} style={{ color: "var(--c-blue)" }}>已转整柜 · 去「整柜管理」看</Link>
                ) : (
                  <>
                    <Link href={convertHref(detail.id)}
                      style={{ border: "1px solid var(--c-green-3)", color: "var(--c-green-deep)", borderRadius: 6, padding: "6px 14px", textDecoration: "none", fontWeight: 600 }}>
                      转整柜
                    </Link>
                    <span style={{ fontSize: 12, color: "var(--t-muted)" }}>柜子装完、有了柜号和提单号再点（去「整柜管理」建整柜，客户、品名、柜型、金额自动带过去）</span>
                  </>
                )}
                {detail.fclDeleted ? <span style={{ fontSize: 12, color: "var(--c-red-deep)" }}>原来转的整柜已被删除，可以重新转</span> : null}
                <Link href={`/staff/chat?clientId=${encodeURIComponent(detail.clientId)}`} style={{ marginLeft: "auto", color: "var(--c-blue)" }}>
                  联系客户（在线对话）
                </Link>
              </div>
            </div>
          ) : null}
        </DetailModal>
      ) : null}
    </section>
  );
}
