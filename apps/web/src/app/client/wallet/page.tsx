"use client";

import { useEffect, useMemo, useState } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import { fetchClientWalletOverview, type ClientWalletOverview } from "../../../services/business-api";

/**
 * 客户端多币种账户页面。
 */
export default function ClientWalletPage() {
  const [data, setData] = useState<ClientWalletOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setLoading(true);
    fetchClientWalletOverview()
      .then(setData)
      .catch((error) => {
        const text = error instanceof Error ? error.message : "加载失败";
        setMessage(`加载失败：${text}`);
      })
      .finally(() => setLoading(false));
  }, []);

  /**
   * 计算 THB 与 CNY 的折算总额。
   */
  const summary = useMemo(() => {
    if (!data) return null;
    const cny = data.accounts.find((item) => item.currency === "CNY")?.balance ?? 0;
    const thb = data.accounts.find((item) => item.currency === "THB")?.balance ?? 0;
    const rate = data.exchangeRate.rate;
    return {
      cny,
      thb,
      pair: data.exchangeRate.pair,
      rate,
      totalCny: cny + thb / rate,
      totalThb: thb + cny * rate,
    };
  }, [data]);

  return (
    <RoleShell allowedRole="client" title="多币种账户">
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff", marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>账户余额（CNY / THB）</h2>
        {loading ? <p style={{ color: "#000000" }}>加载中...</p> : null}
        {summary ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10 }}>
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, background: "#f8fafc" }}>
              <div style={{ color: "#000000", fontSize: 12 }}>人民币余额</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>¥{summary.cny.toFixed(2)}</div>
            </div>
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, background: "#f8fafc" }}>
              <div style={{ color: "#000000", fontSize: 12 }}>泰铢余额</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>฿{summary.thb.toFixed(2)}</div>
            </div>
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, background: "#f8fafc" }}>
              <div style={{ color: "#000000", fontSize: 12 }}>汇率（{summary.pair}）</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{summary.rate.toFixed(4)}</div>
            </div>
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, background: "#f8fafc" }}>
              <div style={{ color: "#000000", fontSize: 12 }}>折算总额（CNY）</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>¥{summary.totalCny.toFixed(2)}</div>
              <div style={{ fontSize: 12, color: "#000000", marginTop: 4 }}>折算总额（THB）：฿{summary.totalThb.toFixed(2)}</div>
            </div>
          </div>
        ) : null}
      </section>
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <h3 style={{ marginTop: 0 }}>说明</h3>
        <ul style={{ margin: 0, paddingLeft: 18, color: "#000000" }}>
          <li>当前为多币种账户 MVP，提供余额与汇率折算透明展示。</li>
          <li>下一步可接入充值记录、消费明细、在线支付网关。</li>
        </ul>
        {message ? <p style={{ marginTop: 10, color: "#b91c1c" }}>{message}</p> : null}
      </section>
    </RoleShell>
  );
}
