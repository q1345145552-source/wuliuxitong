"use client";

import { useEffect, useRef, useState } from "react";
import { useLiveRefresh } from "../../../modules/realtime/useRealtime";
import { createQueryGate } from "../../../modules/shared/request-gate";
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

  /* 晚到的旧列表不许盖新的（2026-10-18 全系统审查 D-P2-6）：实时推送的重拉和「新增 / 删除 / 设默认」之后的刷新同时在路上，
     先发的后回来，会把刚加的地址抹掉、刚删的又冒出来。成功回来的只要不比已经显示的旧就用；失败的谁也不作废（request-gate 用法三） */
  const listGate = useRef(createQueryGate<string>()).current;

  /**
   * 刷新地址列表。
   */
  const reload = async () => {
    const ticket = listGate.begin("all");
    const list = await fetchClientAddresses();
    if (!listGate.accept(ticket, "all")) return;
    setItems(list);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reload()
      .catch((error) => {
        if (cancelled) return;
        const text = error instanceof Error ? error.message : "加载失败";
        setMessage(`加载失败：${text}`);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // 实时更新（2026-10-05）：员工在后台替客户改了地址，这里马上跟着变（reload 本来就不开「加载中」）
  useLiveRefresh({ topics: ["shipping"], enabled: !loading, refresh: () => reload() });

  return (
    <>
      <section style={{ border: "1px solid var(--l-soft)", borderRadius: 12, padding: 16, background: "var(--white)", marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>地址簿管理</h2>
        <p style={{ color: "var(--t-strong)", marginTop: 0 }}>保存收件信息后，可在客户端下单页一键填充。</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8 }}>
          <input value={form.label} onChange={(e) => setForm((v) => ({ ...v, label: e.target.value }))} placeholder="标签（如：曼谷店）" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.contactName} onChange={(e) => setForm((v) => ({ ...v, contactName: e.target.value }))} placeholder="联系人" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.contactPhone} onChange={(e) => setForm((v) => ({ ...v, contactPhone: e.target.value }))} placeholder="联系电话" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.lat} onChange={(e) => setForm((v) => ({ ...v, lat: e.target.value }))} placeholder="纬度（可选）" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.lng} onChange={(e) => setForm((v) => ({ ...v, lng: e.target.value }))} placeholder="经度（可选）" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
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
          style={{ width: "100%", marginTop: 8, border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", resize: "vertical" }}
        />
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              setMessage("");
              try {
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
                } catch (error) {
                  const text = error instanceof Error ? error.message : "新增失败";
                  setMessage(`新增失败：${text}`);
                  return;
                }
                setForm({
                  label: "",
                  contactName: "",
                  contactPhone: "",
                  addressDetail: "",
                  lat: "",
                  lng: "",
                  isDefault: false,
                });
                // 已经存上了：刷新列表失败不能说成「新增失败」—— 不然再点一次就多一条地址（2026-10-18 全系统审查 F-14 同类）
                try {
                  await reload();
                  setMessage("地址新增成功");
                } catch {
                  setMessage("地址新增成功（列表这次没刷新上，别再点保存，稍后刷新页面看）");
                }
              } finally {
                setLoading(false);
              }
            }}
            style={{ border: "none", borderRadius: 8, padding: "8px 12px", background: "var(--c-blue)", color: "var(--white)" }}
          >
            保存地址
          </button>
        </div>
      </section>

      <section style={{ border: "1px solid var(--l-soft)", borderRadius: 12, padding: 16, background: "var(--white)" }}>
        <h3 style={{ marginTop: 0 }}>已保存地址</h3>
        {items.length === 0 ? (
          <p style={{ color: "var(--t-strong)" }}>暂无地址</p>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {items.map((item) => (
              <div key={item.id} style={{ border: "1px solid var(--l-cool)", borderRadius: 10, padding: 10, background: "var(--s-cool)" }}>
                <div style={{ fontWeight: 700 }}>
                  {item.label?.trim() || item.contactName}
                  {item.isDefault ? "（默认）" : ""}
                </div>
                <div style={{ color: "var(--t-strong)", marginTop: 4 }}>{item.contactName} / {item.contactPhone}</div>
                <div style={{ color: "var(--t-strong)", marginTop: 4 }}>{item.addressDetail}</div>
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    disabled={loading || item.isDefault}
                    onClick={async () => {
                      setLoading(true);
                      setMessage("");
                      try {
                        try {
                          await setDefaultClientAddress(item.id);
                        } catch (error) {
                          // 失败要说出来（2026-09-29 Codex 全系统检查：原来按钮看起来像没反应）
                          setMessage(`设为默认失败：${error instanceof Error ? error.message : "请稍后重试"}`);
                          return;
                        }
                        // 已经设好了：刷新失败不能说成「设为默认失败」（2026-10-18 全系统审查 F-14 同类）
                        await reload().catch(() => setMessage("已设为默认（列表这次没刷新上，稍后刷新页面看）"));
                      } finally {
                        setLoading(false);
                      }
                    }}
                    style={{ border: "1px solid var(--t-strong)", borderRadius: 8, padding: "6px 10px", background: "var(--white)" }}
                  >
                    设为默认
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={async () => {
                      setLoading(true);
                      setMessage("");
                      try {
                        try {
                          await deleteClientAddress(item.id);
                        } catch (error) {
                          setMessage(`删除失败：${error instanceof Error ? error.message : "请稍后重试"}`);
                          return;
                        }
                        // 已经删了：刷新失败不能说成「删除失败」（2026-10-18 全系统审查 F-14 同类）
                        await reload().catch(() => setMessage("地址已删除（列表这次没刷新上，稍后刷新页面看）"));
                      } finally {
                        setLoading(false);
                      }
                    }}
                    style={{ border: "1px solid #fecaca", borderRadius: 8, padding: "6px 10px", background: "#fff1f2", color: "var(--c-red-deep)" }}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {message ? <p style={{ marginTop: 10, color: message.includes("失败") ? "var(--c-red-deep)" : "var(--c-green-dark)" }}>{message}</p> : null}
      </section>
    </>
  );
}
