"use client";

import { useState } from "react";
import type { AdminUserItem } from "../../services/business-api";
import { updateShippingConfig, fetchClientShippingConfig, saveClientShippingConfig } from "../../services/business-api";

type RateItem = {
  id: string; transportMode: string; cargoType: string; customerId: string | null;
  customerName: string | null; unitPriceCny: number; disableMinVolume: boolean;
};
type PriceDefault = { transportMode: string; cargoType: string; unitPriceCny: number };

export type ShippingConfigProps = {
  visible: boolean;
  shippingConfigSea: string;
  onSeaChange: (v: string) => void;
  shippingConfigLand: string;
  onLandChange: (v: string) => void;
  configSaving: boolean;
  clientList: AdminUserItem[];
  rateItems: RateItem[];
  rateDefaults: PriceDefault[];
  onToast: (msg: string) => void;
  onRatesReload: () => void;
};

export default function ShippingConfig(props: ShippingConfigProps) {
  const [expandedClientId, setExpandedClientId] = useState<string | null>(null);
  const [clientPrices, setClientPrices] = useState<Record<string, number>>({});
  const [clientMinVolumeDisabled, setClientMinVolumeDisabled] = useState(false);

  if (!props.visible) return null;

  const loadClientPrices = async (clientId: string) => {
    try {
      const result = await fetchClientShippingConfig(clientId);
      setClientPrices(result.prices);
      setClientMinVolumeDisabled(result.disableMinVolume ?? false);
    } catch { /* ignore */ }
  };

  const priceDefaults = [
    { transportMode: "sea", cargoType: "normal", unitPriceCny: 450 },
    { transportMode: "sea", cargoType: "inspection", unitPriceCny: 550 },
    { transportMode: "sea", cargoType: "sensitive", unitPriceCny: 650 },
    { transportMode: "land", cargoType: "normal", unitPriceCny: 280 },
    { transportMode: "land", cargoType: "inspection", unitPriceCny: 380 },
    { transportMode: "land", cargoType: "sensitive", unitPriceCny: 480 },
  ];

  const labelMap: Record<string, string> = { sea_normal: "海运·普货", sea_inspection: "海运·商检", sea_sensitive: "海运·敏感", land_normal: "陆运·普货", land_inspection: "陆运·商检", land_sensitive: "陆运·敏感" };

  return (
    <section style={{ marginBottom: 24, border: "1px solid #e5e7eb", borderRadius: 12, padding: 20, background: "#fff" }}>
      <h2 style={{ marginTop: 0, marginBottom: 12, fontSize: 18 }}>运费配置</h2>
      <p style={{ color: "#000000", marginBottom: 12, fontSize: 14 }}>设置最低计费体积（低消）。当货物体积低于低消时，按低消计算运费。</p>
      <div style={{ display: "grid", gap: 10, maxWidth: 400 }}>
        <div>
          <div style={{ fontSize: 13, color: "#000000", marginBottom: 4 }}>海运低消（立方米）</div>
          <input value={props.shippingConfigSea} onChange={(e) => props.onSeaChange(e.target.value)} type="number" step="0.1" min="0" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" }} />
        </div>
        <div>
          <div style={{ fontSize: 13, color: "#000000", marginBottom: 4 }}>陆运低消（立方米）</div>
          <input value={props.shippingConfigLand} onChange={(e) => props.onLandChange(e.target.value)} type="number" step="0.1" min="0" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" }} />
        </div>
        <button type="button" disabled={props.configSaving} onClick={async () => {
          try {
            await updateShippingConfig({ sea_min_volume: props.shippingConfigSea, land_min_volume: props.shippingConfigLand });
            props.onToast("配置已保存");
          } catch { props.onToast("保存失败"); }
        }} style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "#2563eb", color: "#fff", fontWeight: 500, fontSize: 13, cursor: "pointer", justifySelf: "start" }}>
          {props.configSaving ? "保存中…" : "保存配置"}
        </button>
      </div>

      <h3 style={{ marginTop: 24, marginBottom: 10, fontSize: 16 }}>客户价格管理</h3>
      <div style={{ display: "grid", gap: 6 }}>
        {props.clientList.map((c) => {
          const hasCustom = props.rateItems.some((r) => r.customerId === c.id);
          const hasMinDisabled = props.rateItems.some((r) => r.customerId === c.id && r.disableMinVolume);
          const isView = expandedClientId === c.id;
          const isEdit = expandedClientId === `edit-${c.id}`;
          return (
            <div key={c.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: hasCustom ? "#fefce8" : "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</span>
                  <span style={{ marginLeft: 8, fontSize: 12, color: "#6b7280", fontFamily: "monospace" }}>{c.id}</span>
                  {hasCustom ? <span style={{ marginLeft: 8, fontSize: 11, color: "#d97706" }}>已配置</span> : <span style={{ marginLeft: 8, fontSize: 11, color: "#9ca3af" }}>使用默认</span>}
                  {hasMinDisabled ? <span style={{ marginLeft: 8, fontSize: 11, color: "#8b5cf6" }}>低消已取消</span> : null}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button type="button" onClick={() => { if (isView) { setExpandedClientId(null); return; } setExpandedClientId(c.id); loadClientPrices(c.id); }} style={{ border: "1px solid #2563eb", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#2563eb", cursor: "pointer" }}>{isView ? "收起" : "查看价格"}</button>
                  <button type="button" onClick={() => { if (isEdit) { setExpandedClientId(null); return; } setExpandedClientId(`edit-${c.id}`); loadClientPrices(c.id); }} style={{ border: "none", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#2563eb", color: "#fff", cursor: "pointer" }}>{isEdit ? "收起" : "编辑价格"}</button>
                </div>
              </div>
              {isView ? (
                <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: "#000000" }}>当前价格</div>
                  {priceDefaults.map((d) => {
                    const key = `${d.transportMode}|${d.cargoType}`;
                    const val = clientPrices[key] ?? props.rateDefaults.find((rd) => rd.transportMode === d.transportMode && rd.cargoType === d.cargoType)?.unitPriceCny ?? d.unitPriceCny;
                    return (
                      <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                        <span style={{ width: 100, fontSize: 13 }}>{labelMap[key] ?? key}</span>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>¥{val.toFixed(0)}/m³</span>
                      </div>
                    );
                  })}
                  <div style={{ marginTop: 6, fontSize: 12, color: clientMinVolumeDisabled ? "#8b5cf6" : "#6b7280" }}>
                    低消：{clientMinVolumeDisabled ? "已取消" : `海运${props.shippingConfigSea}方 / 陆运${props.shippingConfigLand}方`}
                  </div>
                </div>
              ) : null}
              {isEdit ? (
                <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10 }} data-client={c.id}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={clientMinVolumeDisabled} onChange={(e) => setClientMinVolumeDisabled(e.target.checked)} />
                    <span style={{ color: "#000000" }}>取消低消</span>
                  </label>
                  {priceDefaults.map((d) => {
                    const key = `${d.transportMode}|${d.cargoType}`;
                    const val = clientPrices[key] ?? d.unitPriceCny;
                    return (
                      <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                        <span style={{ width: 100, fontSize: 13 }}>{labelMap[key] ?? key}</span>
                        <input value={val} data-price-key={key} onChange={(e) => setClientPrices((p) => ({ ...p, [key]: Number(e.target.value) || 0 }))} type="number" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 13, width: 90 }} />
                        <span style={{ fontSize: 12, color: "#9ca3af" }}>¥/m³</span>
                      </div>
                    );
                  })}
                  <button type="button" onClick={async () => {
                    try {
                      const chk = document.querySelector(`[data-client="${c.id}"] input[type="checkbox"]`) as HTMLInputElement;
                      const disableMin = chk?.checked ?? clientMinVolumeDisabled;
                      const prices: Record<string, number> = {};
                      document.querySelectorAll(`[data-client="${c.id}"] input[data-price-key]`).forEach((el) => {
                        const input = el as HTMLInputElement;
                        const key = input.dataset.priceKey;
                        const v = Number(input.value);
                        if (key && v > 0) prices[key] = v;
                      });
                      await saveClientShippingConfig({ clientId: c.id, prices, disableMinVolume: disableMin });
                      props.onRatesReload();
                      await loadClientPrices(c.id);
                      props.onToast("已保存");
                    } catch (err) { props.onToast(`保存失败：${err instanceof Error ? err.message : "网络错误"}`); }
                  }} style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "#2563eb", color: "#fff", fontWeight: 500, fontSize: 13, cursor: "pointer", marginTop: 8 }}>保存客户价格</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
