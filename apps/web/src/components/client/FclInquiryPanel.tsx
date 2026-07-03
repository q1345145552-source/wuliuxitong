"use client";

import { useState } from "react";
import { apiBaseUrl, authHeaders } from "../../services/core-api";

type FclInquiryItem = {
  id: string; clientId: string; productName: string;
  cargoValue: string; cargoWeight: string; address: string;
  containerType: string; serviceType: string; loadingDate: string | null;
  certFileName: string | null; certFileBase64: string | null;
  productImages: Array<{ fileName: string; base64: string }>;
  status: string; remark: string | null; createdByRole: string;
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

  const loadList = async () => {
    try {
      const url = props.isStaff
        ? `${apiBaseUrl()}/client/fcl-inquiries`
        : `${apiBaseUrl()}/client/fcl-inquiries`;
      const r = await fetch(url, { headers: authHeaders() });
      const d = await r.json();
      if (d.code === "OK") setList(d.data.items);
    } catch (e: any) { props.onToast("加载询价记录失败：" + (e.message || "网络错误")); }
    setListLoaded(true);
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
      const r = await fetch(apiBaseUrl() + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.code !== "OK") throw new Error(d.message || "提交失败");
      props.onToast("整柜询价已提交");
      // 清空表单
      setProductName(""); setCargoValue(""); setCargoWeight(""); setAddress("");
      setContainerType("1*40HQ"); setServiceType("清提派"); setLoadingDate("");
      setCertFile(null); setProductImageFiles([]); setProductPreviews([]);
      setSelectedClientId("");
      loadList();
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
    <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 20, background: "#fff", marginBottom: 18 }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>整柜询价</h2>

      {/* 表单 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, maxWidth: 700, marginBottom: 20 }}>
        {props.isStaff && (
          <div style={{ gridColumn: "1/-1" }}>
            <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>选择客户 *</label>
            <input value={selectedClientId} onChange={e => setSelectedClientId(e.target.value)} placeholder="输入客户ID" list="fcl-client-list"
              style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
            <datalist id="fcl-client-list">
              {(props.clients ?? []).map(c => (<option key={c.id} value={c.id}>{c.id} - {c.name}</option>))}
            </datalist>
          </div>
        )}
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>品名 *</label>
          <input value={productName} onChange={e => setProductName(e.target.value)} placeholder="货物品名"
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>货值</label>
          <input value={cargoValue} onChange={e => setCargoValue(e.target.value)} placeholder="如 ¥50,000"
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>货重</label>
          <input value={cargoWeight} onChange={e => setCargoWeight(e.target.value)} placeholder="如 25吨"
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>地址 *</label>
          <input value={address} onChange={e => setAddress(e.target.value)} placeholder="收货/发货地址"
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>柜型</label>
          <select value={containerType} onChange={e => setContainerType(e.target.value)}
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }}>
            <option value="1*40HQ">1*40HQ</option>
            <option value="1*20GP">1*20GP</option>
            <option value="2*40HQ">2*40HQ</option>
            <option value="1*40GP">1*40GP</option>
            <option value="其他">其他</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>清提派/派送</label>
          <select value={serviceType} onChange={e => setServiceType(e.target.value)}
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }}>
            <option value="清提派">清提派（清关+提货+派送）</option>
            <option value="派送">仅派送</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>装柜时间</label>
          <input type="date" value={loadingDate} onChange={e => setLoadingDate(e.target.value)}
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>认证文件</label>
          <input type="file" onChange={e => setCertFile(e.target.files?.[0] || null)}
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />
        </div>
        <div style={{ gridColumn: "1/-1" }}>
          <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>产品图片</label>
          <input type="file" multiple accept="image/*" onChange={e => handleProductImages(e.target.files)}
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13, marginBottom: 8 }} />
          {productPreviews.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {productPreviews.map((src, i) => (
                <img key={i} src={src} alt={`preview-${i}`} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb" }} />
              ))}
            </div>
          )}
        </div>
      </div>

      {message && <p style={{ color: message.includes("失败") ? "#b91c1c" : "#065f46", fontSize: 13, marginBottom: 12 }}>{message}</p>}

      <button disabled={loading} onClick={submit}
        style={{ border: "none", borderRadius: 6, padding: "8px 20px", background: loading ? "#9ca3af" : "#2563eb", color: "#fff", fontSize: 14, cursor: "pointer", marginBottom: 24 }}>
        {loading ? "提交中…" : "提交询价"}
      </button>

      {/* 历史列表 */}
      <h3 style={{ fontSize: 15, marginBottom: 10 }}>询价记录</h3>
      {!listLoaded && <button onClick={loadList} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 14px", background: "#fff", cursor: "pointer", fontSize: 13 }}>加载记录</button>}
      {listLoaded && list.length === 0 && <p style={{ color: "#9ca3af", fontSize: 13 }}>暂无询价记录</p>}
      {list.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
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
                <tr key={item.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "6px 8px" }}>{item.productName}</td>
                  <td style={{ padding: "6px 8px" }}>{item.containerType}</td>
                  <td style={{ padding: "6px 8px" }}>{item.cargoWeight || "—"}</td>
                  <td style={{ padding: "6px 8px" }}>{item.serviceType}</td>
                  <td style={{ padding: "6px 8px" }}>{item.loadingDate || "—"}</td>
                  <td style={{ padding: "6px 8px" }}>
                    {item.status === "pending" ? "⏳ 待处理" : item.status === "processing" ? "🔄 处理中" : "✅ 完成"}
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
