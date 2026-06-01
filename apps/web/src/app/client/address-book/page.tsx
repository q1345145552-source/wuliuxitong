"use client";

import { useEffect, useState } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import {
  createClientAddress,
  deleteClientAddress,
  fetchClientAddresses,
  setDefaultClientAddress,
  type ClientAddressItem,
} from "../../../services/business-api";

/**
 * 客户端常用地址库页面。
 */
export default function ClientAddressBookPage() {
  const [items, setItems] = useState<ClientAddressItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    label: "",
    contactName: "",
    contactPhone: "",
    addressDetail: "",
    lat: "",
    lng: "",
    isDefault: false,
  });

  /**
   * 刷新地址列表。
   */
  const reload = async () => {
    const list = await fetchClientAddresses();
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
    <RoleShell allowedRole="client" title="常用地址库">
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff", marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>地址簿管理</h2>
        <p style={{ color: "#1f2937", marginTop: 0 }}>保存收件信息后，可在客户端下单页一键填充。</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8 }}>
          <input value={form.label} onChange={(e) => setForm((v) => ({ ...v, label: e.target.value }))} placeholder="标签（如：曼谷店）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.contactName} onChange={(e) => setForm((v) => ({ ...v, contactName: e.target.value }))} placeholder="联系人" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.contactPhone} onChange={(e) => setForm((v) => ({ ...v, contactPhone: e.target.value }))} placeholder="联系电话" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.lat} onChange={(e) => setForm((v) => ({ ...v, lat: e.target.value }))} placeholder="纬度（可选）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.lng} onChange={(e) => setForm((v) => ({ ...v, lng: e.target.value }))} placeholder="经度（可选）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
            <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm((v) => ({ ...v, isDefault: e.target.checked }))} />
            设为默认地址
          </label>
        </div>
        <textarea
          value={form.addressDetail}
          onChange={(e) => setForm((v) => ({ ...v, addressDetail: e.target.value }))}
          placeholder="详细地址"
          rows={3}
          style={{ width: "100%", marginTop: 8, border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", resize: "vertical" }}
        />
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              setMessage("");
              try {
                await createClientAddress({
                  label: form.label.trim() || undefined,
                  contactName: form.contactName.trim(),
                  contactPhone: form.contactPhone.trim(),
                  addressDetail: form.addressDetail.trim(),
                  lat: form.lat.trim() ? Number(form.lat) : undefined,
                  lng: form.lng.trim() ? Number(form.lng) : undefined,
                  isDefault: form.isDefault,
                });
                setForm({
                  label: "",
                  contactName: "",
                  contactPhone: "",
                  addressDetail: "",
                  lat: "",
                  lng: "",
                  isDefault: false,
                });
                await reload();
                setMessage("地址新增成功");
              } catch (error) {
                const text = error instanceof Error ? error.message : "新增失败";
                setMessage(`新增失败：${text}`);
              } finally {
                setLoading(false);
              }
            }}
            style={{ border: "none", borderRadius: 8, padding: "8px 12px", background: "#2563eb", color: "#fff" }}
          >
            保存地址
          </button>
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <h3 style={{ marginTop: 0 }}>已保存地址</h3>
        {items.length === 0 ? (
          <p style={{ color: "#1f2937" }}>暂无地址</p>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {items.map((item) => (
              <div key={item.id} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, background: "#f8fafc" }}>
                <div style={{ fontWeight: 700 }}>
                  {item.label?.trim() || item.contactName}
                  {item.isDefault ? "（默认）" : ""}
                </div>
                <div style={{ color: "#334155", marginTop: 4 }}>{item.contactName} / {item.contactPhone}</div>
                <div style={{ color: "#334155", marginTop: 4 }}>{item.addressDetail}</div>
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    disabled={loading || item.isDefault}
                    onClick={async () => {
                      setLoading(true);
                      try {
                        await setDefaultClientAddress(item.id);
                        await reload();
                      } finally {
                        setLoading(false);
                      }
                    }}
                    style={{ border: "1px solid #1f2937", borderRadius: 8, padding: "6px 10px", background: "#fff" }}
                  >
                    设为默认
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={async () => {
                      setLoading(true);
                      try {
                        await deleteClientAddress(item.id);
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
            ))}
          </div>
        )}
        {message ? <p style={{ marginTop: 10, color: message.includes("失败") ? "#b91c1c" : "#166534" }}>{message}</p> : null}
      </section>
    </RoleShell>
  );
}
