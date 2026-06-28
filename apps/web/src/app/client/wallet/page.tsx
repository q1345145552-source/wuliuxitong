"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import {
  fetchClientWalletOverview,
  fetchClientWalletRecharges,
  submitRecharge,
  type ClientWalletOverview,
  type WalletRechargeItem,
} from "../../../services/business-api";

const PAYMENT_METHODS = [
  { value: "WECHAT", label: "微信" },
  { value: "ALIPAY", label: "支付宝" },
  { value: "BANK_TRANSFER", label: "银行转账" },
] as const;

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  WECHAT: "微信",
  ALIPAY: "支付宝",
  BANK_TRANSFER: "银行转账",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "待审核",
  APPROVED: "已通过",
  REJECTED: "已拒绝",
};

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: "#fef3c7", text: "#92400e" },
  APPROVED: { bg: "#d1fae5", text: "#065f46" },
  REJECTED: { bg: "#fee2e2", text: "#991b1b" },
};

/**
 * 客户端多币种账户页面（含充值功能）。
 */
export default function ClientWalletPage() {
  const [data, setData] = useState<ClientWalletOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  // 充值相关状态
  const [showRechargeModal, setShowRechargeModal] = useState(false);
  const [rechargeAmount, setRechargeAmount] = useState("");
  const [rechargeCurrency, setRechargeCurrency] = useState("CNY");
  const [rechargeMethod, setRechargeMethod] = useState("WECHAT");
  const [rechargeRemark, setRechargeRemark] = useState("");
  const [rechargeProof, setRechargeProof] = useState<string | null>(null);
  const [rechargeSubmitting, setRechargeSubmitting] = useState(false);
  const [rechargeError, setRechargeError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 充值记录
  const [recharges, setRecharges] = useState<WalletRechargeItem[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [overview, recs] = await Promise.all([
        fetchClientWalletOverview(),
        fetchClientWalletRecharges(),
      ]);
      setData(overview);
      setRecharges(recs.recharges);
    } catch (error) {
      const text = error instanceof Error ? error.message : "加载失败";
      setMessage(`加载失败：${text}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // 处理付款凭证上传
  const handleProofUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setRechargeProof(result);
    };
    reader.readAsDataURL(file);
  };

  // 提交充值
  const handleSubmitRecharge = async () => {
    const amount = Number(rechargeAmount);
    if (!amount || amount <= 0 || !Number.isFinite(amount)) {
      setRechargeError("请输入有效的充值金额");
      return;
    }
    if (!rechargeProof) {
      setRechargeError("请上传付款凭证");
      return;
    }
    setRechargeSubmitting(true);
    setRechargeError("");
    try {
      await submitRecharge({
        amount,
        currency: rechargeCurrency,
        paymentMethod: rechargeMethod,
        proofImage: rechargeProof,
        remark: rechargeRemark.trim() || undefined,
      });
      setShowRechargeModal(false);
      resetRechargeForm();
      await loadData();
    } catch (error) {
      const text = error instanceof Error ? error.message : "提交失败";
      setRechargeError(text);
    } finally {
      setRechargeSubmitting(false);
    }
  };

  const resetRechargeForm = () => {
    setRechargeAmount("");
    setRechargeCurrency("CNY");
    setRechargeMethod("WECHAT");
    setRechargeRemark("");
    setRechargeProof(null);
    setRechargeError("");
  };

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
      {/* 余额卡片 */}
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff", marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>账户余额（CNY / THB）</h2>
          <button
            onClick={() => setShowRechargeModal(true)}
            style={{
              border: "none",
              borderRadius: 8,
              padding: "8px 20px",
              background: "#2563eb",
              color: "#fff",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            充值
          </button>
        </div>
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

      {/* 充值记录 */}
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff", marginBottom: 14 }}>
        <h3 style={{ margin: "0 0 12px" }}>充值记录</h3>
        {recharges.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: 13 }}>暂无充值记录</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "#374151" }}>时间</th>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "#374151" }}>币种</th>
                  <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "#374151" }}>金额</th>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "#374151" }}>支付方式</th>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "#374151" }}>状态</th>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "#374151" }}>备注</th>
                </tr>
              </thead>
              <tbody>
                {recharges.map((r) => {
                  const sc = STATUS_COLORS[r.status] ?? { bg: "#f3f4f6", text: "#374151" };
                  return (
                    <tr key={r.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                        {new Date(r.createdAt).toLocaleString("zh-CN", {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td style={{ padding: "8px 12px" }}>{r.currency}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600 }}>
                        {r.currency === "CNY" ? "¥" : "฿"}{r.amount.toFixed(2)}
                      </td>
                      <td style={{ padding: "8px 12px" }}>{PAYMENT_METHOD_LABELS[r.paymentMethod] ?? r.paymentMethod}</td>
                      <td style={{ padding: "8px 12px" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 10,
                            fontSize: 12,
                            background: sc.bg,
                            color: sc.text,
                          }}
                        >
                          {STATUS_LABELS[r.status] ?? r.status}
                        </span>
                      </td>
                      <td style={{ padding: "8px 12px", color: "#6b7280", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.reviewRemark || r.remark || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 说明 */}
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <h3 style={{ marginTop: 0 }}>说明</h3>
        <ul style={{ margin: 0, paddingLeft: 18, color: "#000000" }}>
          <li>支持人民币（CNY）和泰铢（THB）充值，提交后由管理员审核。</li>
          <li>每天 0 点自动更新实时汇率，人民币和泰铢余额互相折算显示。</li>
          <li>如有疑问请联系客服。</li>
        </ul>
        {message ? <p style={{ marginTop: 10, color: "#b91c1c" }}>{message}</p> : null}
      </section>

      {/* 充值弹窗 */}
      {showRechargeModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.4)",
            padding: 16,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowRechargeModal(false);
              resetRechargeForm();
            }
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 480,
              background: "#fff",
              borderRadius: 12,
              padding: 24,
              boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
              maxHeight: "90vh",
              overflow: "auto",
            }}
          >
            <h3 style={{ margin: "0 0 20px", fontSize: 18, fontWeight: 600 }}>充值申请</h3>

            {/* 币种选择 */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: 14, color: "#374151" }}>充值币种</label>
              <div style={{ display: "flex", gap: 8 }}>
                {["CNY", "THB"].map((cur) => (
                  <button
                    key={cur}
                    type="button"
                    onClick={() => setRechargeCurrency(cur)}
                    style={{
                      flex: 1,
                      padding: "10px 16px",
                      borderRadius: 8,
                      border: rechargeCurrency === cur ? "2px solid #2563eb" : "1px solid #d1d5db",
                      background: rechargeCurrency === cur ? "#eff6ff" : "#fff",
                      color: rechargeCurrency === cur ? "#2563eb" : "#374151",
                      fontWeight: 600,
                      fontSize: 14,
                      cursor: "pointer",
                    }}
                  >
                    {cur === "CNY" ? "¥ 人民币" : "฿ 泰铢"}
                  </button>
                ))}
              </div>
            </div>

            {/* 金额 */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: 14, color: "#374151" }}>充值金额</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="请输入金额"
                value={rechargeAmount}
                onChange={(e) => setRechargeAmount(e.target.value)}
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  fontSize: 16,
                  boxSizing: "border-box",
                }}
              />
            </div>

            {/* 支付方式 */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: 14, color: "#374151" }}>支付方式</label>
              <div style={{ display: "flex", gap: 8 }}>
                {PAYMENT_METHODS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setRechargeMethod(m.value)}
                    style={{
                      flex: 1,
                      padding: "10px 12px",
                      borderRadius: 8,
                      border: rechargeMethod === m.value ? "2px solid #2563eb" : "1px solid #d1d5db",
                      background: rechargeMethod === m.value ? "#eff6ff" : "#fff",
                      color: rechargeMethod === m.value ? "#2563eb" : "#374151",
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 付款凭证 */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: 14, color: "#374151" }}>
                付款凭证 <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleProofUpload}
                style={{ fontSize: 13 }}
              />
              {rechargeProof && (
                <div style={{ marginTop: 8 }}>
                  <img
                    src={rechargeProof}
                    alt="付款凭证"
                    style={{ width: "100%", maxHeight: 200, objectFit: "contain", borderRadius: 8, border: "1px solid #e5e7eb" }}
                  />
                </div>
              )}
            </div>

            {/* 备注 */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: 14, color: "#374151" }}>备注（选填）</label>
              <input
                type="text"
                placeholder="可填写备注信息"
                value={rechargeRemark}
                onChange={(e) => setRechargeRemark(e.target.value)}
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  fontSize: 14,
                  boxSizing: "border-box",
                }}
              />
            </div>

            {rechargeError && (
              <div style={{ marginBottom: 16, padding: "8px 12px", background: "#fef2f2", color: "#991b1b", borderRadius: 8, fontSize: 13 }}>
                {rechargeError}
              </div>
            )}

            {/* 按钮 */}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setShowRechargeModal(false);
                  resetRechargeForm();
                }}
                disabled={rechargeSubmitting}
                style={{
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  padding: "10px 20px",
                  background: "#fff",
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSubmitRecharge}
                disabled={rechargeSubmitting}
                style={{
                  border: "none",
                  borderRadius: 8,
                  padding: "10px 24px",
                  background: "#2563eb",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: rechargeSubmitting ? "not-allowed" : "pointer",
                  opacity: rechargeSubmitting ? 0.7 : 1,
                  fontSize: 14,
                }}
              >
                {rechargeSubmitting ? "提交中..." : "提交申请"}
              </button>
            </div>
          </div>
        </div>
      )}
    </RoleShell>
  );
}
