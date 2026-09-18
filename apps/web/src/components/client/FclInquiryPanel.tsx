"use client";

import { useRef, useState } from "react";
import { apiBaseUrl, apiRequest } from "../../services/core-api";
import { createRequestGate } from "../../modules/shared/request-gate";

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
};

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
      {!listLoaded && <button onClick={() => loadList(1)} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 14px", background: "var(--white)", cursor: "pointer", fontSize: 13 }}>加载记录</button>}
      {listLoaded && listError && <button onClick={() => { setListError(false); setListLoaded(false); }} style={{ border: "1px solid #fca5a5", borderRadius: 6, padding: "6px 14px", background: "var(--white)", color: "var(--c-red-2)", cursor: "pointer", fontSize: 13 }}>加载失败，点击重试</button>}
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
              <th style={{ padding: "6px 8px" }}>品名</th>
              <th style={{ padding: "6px 8px" }}>柜型</th>
              <th style={{ padding: "6px 8px" }}>货重</th>
              <th style={{ padding: "6px 8px" }}>服务</th>
              <th style={{ padding: "6px 8px" }}>装柜时间</th>
              <th style={{ padding: "6px 8px" }}>状态</th>
              <th style={{ padding: "6px 8px" }}>提交时间</th>
            </tr></thead>
            <tbody>
              {list.map((item) => (
                <tr key={item.id} style={{ borderBottom: "1px solid var(--s-cool-2)" }}>
                  <td style={{ padding: "6px 8px" }}>{item.productName}</td>
                  <td style={{ padding: "6px 8px" }}>{item.containerType}</td>
                  <td style={{ padding: "6px 8px" }}>{item.cargoWeight || "—"}</td>
                  <td style={{ padding: "6px 8px" }}>{item.serviceType}</td>
                  <td style={{ padding: "6px 8px" }}>{item.loadingDate || "—"}</td>
                  <td style={{ padding: "6px 8px" }}>
                    {item.status === "pending" ? "待处理" : item.status === "processing" ? "处理中" : "完成"}
                  </td>
                  <td style={{ padding: "6px 8px", fontSize: 11 }}>{item.createdAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
