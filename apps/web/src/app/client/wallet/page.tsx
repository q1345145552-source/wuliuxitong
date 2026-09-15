"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRequestGate } from "../../../modules/shared/request-gate";
import {
  fetchClientWalletOverview,
  fetchClientWalletRecharges,
  fetchConsolidationLedger,
  type ConsolidationLedgerItem,
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
  PENDING: { bg: "var(--c-amber-bg)", text: "var(--c-amber-deep)" },
  APPROVED: { bg: "var(--c-green-bg)", text: "var(--c-green-deep)" },
  REJECTED: { bg: "var(--c-red-bg)", text: "var(--c-red-dark)" },
};

// 2026-09-01 Codex 复核收尾：流水每页条数（后端默认也是 50，两边对齐）
const LEDGER_PAGE_SIZE = 50;

/**
 * 客户端余额页面（含充值功能）。
 */
export default function ClientWalletPage() {
  const [data, setData] = useState<ClientWalletOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  // 充值相关状态
  const [showRechargeModal, setShowRechargeModal] = useState(false);
  const [rechargeAmount, setRechargeAmount] = useState("");
  const [rechargeMethod, setRechargeMethod] = useState("WECHAT");
  const [rechargeRemark, setRechargeRemark] = useState("");
  const [rechargeProof, setRechargeProof] = useState<string | null>(null);
  const [rechargeSubmitting, setRechargeSubmitting] = useState(false);
  const [rechargeError, setRechargeError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 充值记录
  const [recharges, setRecharges] = useState<WalletRechargeItem[]>([]);
  // 集货余额流水（充值到账 / 集货付款 / 撤销退款）
  const [ledger, setLedger] = useState<ConsolidationLedgerItem[]>([]);
  // 2026-09-01 Codex 复核收尾：流水分页（照抄客户端预报单列表那套，教训21：
  // 原来后端只回前 200 条、页面全渲染，超了老记录静默消失，客户没法知道后面还有）
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerTotal, setLedgerTotal] = useState(0);

  /* 2026-09-01 终验收尾：流水请求自增序号（照抄 LastmileAddressPanel 的 loadSeq 写法）。
     快速连点翻页会连发多个请求，网络上谁先回没有保证——每次发请求领一个序号，
     响应回来时序号已不是最新的就整个丢弃，只让最后一次请求的结果落地。 */
  const ledgerSeqRef = useRef(0);

  /* 2026-09-01 竞态全扫：「余额 + 充值记录」自己的门闩（request-gate 用法一）。
     和流水的 ledgerSeqRef 是两份独立数据上下文，各配各的门，互不作废。
     治的病：充值提交后触发的刷新和首次加载并发时，谁先回没有保证——
     晚到的旧响应会把刚充完值的新余额盖回旧数字。 */
  const walletGate = useRef(createRequestGate()).current;

  const loadData = useCallback(async () => {
    setLoading(true);
    // 2026-09-01 竞态全扫：余额+充值记录出发时领号
    const walletTicket = walletGate.begin();
    // 全量刷新也占一个序号：还在路上的翻页旧响应不许盖掉刷新结果
    const seq = ++ledgerSeqRef.current;
    try {
      const [overview, recs, led] = await Promise.all([
        fetchClientWalletOverview(),
        fetchClientWalletRecharges(),
        fetchConsolidationLedger({ page: 1, pageSize: LEDGER_PAGE_SIZE }),
      ]);
      // 2026-09-01 竞态全扫：号作废（期间又发起了新一轮刷新）就整段不落地，旧余额不许盖新余额
      if (walletGate.isCurrent(walletTicket)) {
        setData(overview);
        setRecharges(recs.recharges);
      }
      if (seq === ledgerSeqRef.current) {
        setLedger(led.items);
        setLedgerTotal(led.total);
        // 全量刷新（首次加载/充值提交后）拿的是第 1 页；用后端回的 page 校准，别跟表格错位
        setLedgerPage(led.page);
      }
    } catch (error) {
      // 2026-09-01 竞态全扫：过期请求的报错也不提示，免得错误提示安在新请求头上
      if (!walletGate.isCurrent(walletTicket)) return;
      const text = error instanceof Error ? error.message : "加载失败";
      setMessage(`加载失败：${text}`);
    } finally {
      // 2026-09-01 竞态全扫：旧请求不许提前掐掉新请求的加载态
      if (walletGate.isCurrent(walletTicket)) setLoading(false);
    }
  }, [walletGate]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  /* 2026-09-01 终验收尾：翻页改成「请求成功后页码和数据一起更新」。
     原来是先 setLedgerPage 再靠 useEffect 发请求——请求失败时表格还是旧页的数据、
     页码却已经跳了，客户看着「第 2 页」实际是第 1 页的流水。现在目标页只存在
     临时变量 targetPage 里，成功才落地（并用后端回的 page 校准）；失败页码不动、给提示。 */
  const loadLedgerPage = useCallback(async (targetPage: number) => {
    const seq = ++ledgerSeqRef.current;
    try {
      const res = await fetchConsolidationLedger({ page: targetPage, pageSize: LEDGER_PAGE_SIZE });
      if (seq !== ledgerSeqRef.current) return; // 旧响应后到，丢弃
      setLedger(res.items);
      setLedgerTotal(res.total);
      setLedgerPage(res.page);
    } catch (error) {
      if (seq !== ledgerSeqRef.current) return; // 过期请求的报错也不提示，免得盖住新请求的结果
      const text = error instanceof Error ? error.message : "未知错误";
      // 失败时页码和表格都保持原样，只提示；再点一次按钮即可重试
      setMessage(`流水翻页失败：${text}`);
    }
  }, []);

  // 处理付款凭证上传
  const handleProofUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setRechargeProof(result);
    };
    reader.onerror = () => setRechargeError("文件读取失败，请重试");
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
    setRechargeMethod("WECHAT");
    setRechargeRemark("");
    setRechargeProof(null);
    setRechargeError("");
  };

  /** 集货余额只有人民币（2026-08-07 起泰铢废弃） */
  const balance = useMemo(() => {
    if (!data) return 0;
    if (typeof (data as any).balance === "number") return (data as any).balance as number;
    return data.accounts.find((item) => item.currency === "CNY")?.balance ?? 0;
  }, [data]);

  return (
    <>
      {/* 余额卡片 */}
      <section style={{ border: "1px solid var(--l-soft)", borderRadius: 12, padding: 16, background: "var(--white)", marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>集货余额</h2>
          <button
            onClick={() => setShowRechargeModal(true)}
            style={{
              border: "none",
              borderRadius: 8,
              padding: "8px 20px",
              background: "var(--c-navy)",
              color: "var(--white)",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            充值
          </button>
        </div>
        {loading ? <p style={{ color: "var(--t-strong)" }}>加载中...</p> : null}
        <div style={{ border: "1px solid var(--l-cool)", borderRadius: 10, padding: "14px 16px", background: "var(--s-cool)", maxWidth: 320 }}>
          <div style={{ color: "var(--t-strong)", fontSize: 12 }}>可用余额（人民币）</div>
          <div style={{ fontSize: 30, fontWeight: 700 }}>¥{balance.toFixed(2)}</div>
          <div style={{ fontSize: 12, color: "var(--t-muted)", marginTop: 4 }}>只能用于集货拼柜付款</div>
        </div>
      </section>

      {/* 余额流水（2026-08-07 新增）：每一笔进出都在这里，客户能自己对账 */}
      <section style={{ border: "1px solid var(--l-soft)", borderRadius: 12, padding: 16, background: "var(--white)", marginBottom: 14 }}>
        <h3 style={{ margin: "0 0 12px" }}>余额流水</h3>
        {/* 2026-09-01 Codex 复核收尾：共 N 条用后端真实 total + 翻页按钮（照抄预报单列表的写法，教训21） */}
        {ledgerTotal > 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "var(--t-strong)" }}>共 {ledgerTotal} 条 · 第 {ledgerPage}/{Math.max(1, Math.ceil(ledgerTotal / LEDGER_PAGE_SIZE))} 页</div>
            <div style={{ display: "flex", gap: 6 }}>
              {/* 2026-09-01 终验收尾：点按钮不再直接改页码，改成发请求、成功后才翻页（见 loadLedgerPage） */}
              <button type="button" onClick={() => void loadLedgerPage(Math.max(1, ledgerPage - 1))} disabled={ledgerPage <= 1} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 12px", background: ledgerPage <= 1 ? "var(--s-sunken)" : "var(--white)", color: ledgerPage <= 1 ? "var(--t-faint)" : "var(--t-heading)", cursor: ledgerPage <= 1 ? "default" : "pointer", fontSize: 12 }}>上一页</button>
              <button type="button" onClick={() => void loadLedgerPage(Math.min(Math.max(1, Math.ceil(ledgerTotal / LEDGER_PAGE_SIZE)), ledgerPage + 1))} disabled={ledgerPage >= Math.max(1, Math.ceil(ledgerTotal / LEDGER_PAGE_SIZE))} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 12px", background: ledgerPage >= Math.max(1, Math.ceil(ledgerTotal / LEDGER_PAGE_SIZE)) ? "var(--s-sunken)" : "var(--white)", color: ledgerPage >= Math.max(1, Math.ceil(ledgerTotal / LEDGER_PAGE_SIZE)) ? "var(--t-faint)" : "var(--t-heading)", cursor: ledgerPage >= Math.max(1, Math.ceil(ledgerTotal / LEDGER_PAGE_SIZE)) ? "default" : "pointer", fontSize: 12 }}>下一页</button>
            </div>
          </div>
        ) : null}
        {ledger.length === 0 ? (
          <p style={{ color: "var(--t-muted)", fontSize: 13 }}>暂无流水</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--s-cool-2)", borderBottom: "1px solid var(--l-soft)" }}>
                  {["时间", "类型", "来源", "单号", "金额", "余额", "备注"].map((h, i) => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: i === 4 || i === 5 ? "right" : "left", fontWeight: 600, color: "var(--t-body)", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ledger.map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid var(--s-sunken)" }}>
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      {new Date(r.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>{r.typeLabel}</td>
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>{r.source || "—"}</td>
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap", fontFamily: "monospace", fontSize: 12 }}>{r.refNo || "—"}</td>
                    {/* 进账带 +、出账带 −，一眼看得出是加钱还是扣钱 */}
                    <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>
                      {r.amount >= 0 ? "+" : "−"}¥{Math.abs(r.amount).toFixed(2)}
                    </td>
                    <td style={{ padding: "8px 12px", textAlign: "right", whiteSpace: "nowrap", color: "var(--t-muted)" }}>¥{r.balanceAfter.toFixed(2)}</td>
                    <td style={{ padding: "8px 12px", color: "var(--t-muted)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.remark}>{r.remark || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 充值记录 */}
      <section style={{ border: "1px solid var(--l-soft)", borderRadius: 12, padding: 16, background: "var(--white)", marginBottom: 14 }}>
        <h3 style={{ margin: "0 0 12px" }}>充值记录</h3>
        {recharges.length === 0 ? (
          <p style={{ color: "var(--t-muted)", fontSize: 13 }}>暂无充值记录</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--s-alt)", borderBottom: "1px solid var(--l-soft)" }}>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "var(--t-body)" }}>时间</th>
                  <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "var(--t-body)" }}>金额</th>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "var(--t-body)" }}>支付方式</th>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "var(--t-body)" }}>状态</th>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "var(--t-body)" }}>备注</th>
                </tr>
              </thead>
              <tbody>
                {recharges.map((r) => {
                  const sc = STATUS_COLORS[r.status] ?? { bg: "var(--s-sunken)", text: "var(--t-body)" };
                  return (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--s-sunken)" }}>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                        {new Date(r.createdAt).toLocaleString("zh-CN", {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600 }}>
                        ¥{r.amount.toFixed(2)}
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
                      <td style={{ padding: "8px 12px", color: "var(--t-muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
      <section style={{ border: "1px solid var(--l-soft)", borderRadius: 12, padding: 16, background: "var(--white)" }}>
        <h3 style={{ marginTop: 0 }}>说明</h3>
        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--t-strong)" }}>
          <li>集货余额<strong>只能用于集货拼柜（普通版和仓库版）付款</strong>，不能用于普通运单。</li>
          <li>充值只收人民币。提交充值申请并上传水单后，由管理员审核，通过才会到账。</li>
          <li>在集货拼柜里付款时<strong>直接扣余额、当场完成</strong>，不用再传水单。付款不可自行撤销，点错了请联系客服。</li>
          <li>如有疑问请联系客服。</li>
        </ul>
        {message ? <p style={{ marginTop: 10, color: "var(--c-red-deep)" }}>{message}</p> : null}
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
              background: "var(--white)",
              borderRadius: 12,
              padding: 24,
              boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
              maxHeight: "90vh",
              overflow: "auto",
            }}
          >
            <h3 style={{ margin: "0 0 20px", fontSize: 18, fontWeight: 600 }}>充值申请</h3>

            {/* 金额 */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: 14, color: "var(--t-body)" }}>充值金额</label>
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
                  border: "1px solid var(--l-strong)",
                  borderRadius: 8,
                  fontSize: 16,
                  boxSizing: "border-box",
                }}
              />
            </div>

            {/* 支付方式 */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: 14, color: "var(--t-body)" }}>支付方式</label>
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
                      border: rechargeMethod === m.value ? "2px solid var(--c-blue)" : "1px solid var(--l-strong)",
                      background: rechargeMethod === m.value ? "var(--c-blue-bg)" : "var(--white)",
                      color: rechargeMethod === m.value ? "var(--c-blue)" : "var(--t-body)",
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
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: 14, color: "var(--t-body)" }}>
                付款凭证 <span style={{ color: "var(--c-red)" }}>*</span>
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
                    style={{ width: "100%", maxHeight: 200, objectFit: "contain", borderRadius: 8, border: "1px solid var(--l-soft)" }}
                  />
                </div>
              )}
            </div>

            {/* 备注 */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: 14, color: "var(--t-body)" }}>备注（选填）</label>
              <input
                type="text"
                placeholder="可填写备注信息"
                value={rechargeRemark}
                onChange={(e) => setRechargeRemark(e.target.value)}
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  border: "1px solid var(--l-strong)",
                  borderRadius: 8,
                  fontSize: 14,
                  boxSizing: "border-box",
                }}
              />
            </div>

            {rechargeError && (
              <div style={{ marginBottom: 16, padding: "8px 12px", background: "#fef2f2", color: "var(--c-red-dark)", borderRadius: 8, fontSize: 13 }}>
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
                  border: "1px solid var(--l-strong)",
                  borderRadius: 8,
                  padding: "10px 20px",
                  background: "var(--white)",
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
                  background: "var(--c-blue)",
                  color: "var(--white)",
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
    </>
  );
}
