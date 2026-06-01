"use client";

import { useEffect, useState } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import {
  deleteClientDocument,
  fetchClientDocuments,
  uploadClientDocument,
  type ClientDocumentItem,
} from "../../../services/business-api";

/**
 * 将文件读取为 base64 字符串。
 */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const base64 = value.includes(",") ? value.split(",").pop() ?? "" : "";
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

/**
 * 客户端清关与 KYC 文件上传页面。
 */
export default function ClientDocumentsPage() {
  const [items, setItems] = useState<ClientDocumentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [docType, setDocType] = useState("commercial-invoice");

  /**
   * 刷新文档列表。
   */
  const reload = async () => {
    const list = await fetchClientDocuments();
    setItems(list);
  };

  useEffect(() => {
    setLoading(true);
    reload()
      .catch((error) => {
        const text = error instanceof Error ? error.message : "加载失败";
        setMessage(`加载失败：${text}`);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <RoleShell allowedRole="client" title="清关文件上传">
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff", marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>KYC & Documents</h2>
        <p style={{ color: "#000000", marginTop: 0 }}>
          支持上传身份证、营业执照、商业发票与装箱单，支持 PDF/图片在线预览。
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          >
            <option value="id-card">身份证</option>
            <option value="business-license">营业执照</option>
            <option value="commercial-invoice">商业发票</option>
            <option value="packing-list">装箱单</option>
          </select>
          <label
            style={{
              border: "1px solid #2563eb",
              borderRadius: 8,
              padding: "8px 12px",
              color: "#1d4ed8",
              background: "#eff6ff",
              cursor: "pointer",
            }}
          >
            上传文件
            <input
              type="file"
              accept="image/*,.pdf"
              style={{ display: "none" }}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setLoading(true);
                setMessage("");
                try {
                  const contentBase64 = await readFileAsBase64(file);
                  await uploadClientDocument({
                    docType,
                    fileName: file.name,
                    mime: file.type || "application/octet-stream",
                    contentBase64,
                  });
                  await reload();
                  setMessage("文件上传成功");
                } catch (error) {
                  const text = error instanceof Error ? error.message : "上传失败";
                  setMessage(`上传失败：${text}`);
                } finally {
                  setLoading(false);
                }
              }}
            />
          </label>
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <h3 style={{ marginTop: 0 }}>已上传文件</h3>
        {items.length === 0 ? (
          <p style={{ color: "#000000" }}>暂无上传文件</p>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {items.map((item) => {
              const dataUrl = `data:${item.mime};base64,${item.contentBase64}`;
              const isPdf = item.mime.toLowerCase().includes("pdf");
              return (
                <div key={item.id} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, background: "#f8fafc" }}>
                  <div style={{ fontWeight: 700 }}>{item.fileName}</div>
                  <div style={{ fontSize: 12, color: "#000000", marginTop: 2 }}>
                    类型：{item.docType} / 上传时间：{item.createdAt}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    {isPdf ? (
                      <iframe src={dataUrl} style={{ width: "100%", height: 220, border: "1px solid #cbd5e1", borderRadius: 8 }} title={item.fileName} />
                    ) : (
                      <img src={dataUrl} alt={item.fileName} style={{ maxWidth: "100%", maxHeight: 240, borderRadius: 8, border: "1px solid #cbd5e1" }} />
                    )}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={async () => {
                        setLoading(true);
                        try {
                          await deleteClientDocument(item.id);
                          await reload();
                        } finally {
                          setLoading(false);
                        }
                      }}
                      style={{ border: "1px solid #fecaca", borderRadius: 8, padding: "6px 10px", background: "#fff1f2", color: "#b91c1c" }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {message ? <p style={{ marginTop: 10, color: message.includes("失败") ? "#b91c1c" : "#166534" }}>{message}</p> : null}
      </section>
    </RoleShell>
  );
}
