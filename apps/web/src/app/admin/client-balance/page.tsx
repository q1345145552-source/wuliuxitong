"use client";

/**
 * 客户余额（2026-11-27，财务系统2 ADR 0191 第 2 轮）—— 只给管理员。
 * 老板：「充值的话线下转，然后管理员去加金额」「加了就算数」。客户只有这一个余额：集货拼柜当场扣，运费账单出来自动扣。
 *
 *   · 按唛头搜客户，列出余额（负数标红）；点「看流水」看这个客户的每一笔
 *   · 「给客户加金额」「减金额」：弹窗两步 —— 先填，再把唛头和金额大字核一遍才真提交（加错了系统拦不住，老板很在意）
 *   · 每一笔「管理员充值」后面有「冲掉」：整笔冲，必须写原因，不够冲也照冲成负数
 *   · 防连点：弹窗打开时生成一次性提交编号，后端按它去重（同一个编号再来回第一次的结果）；提交中按钮禁用
 *   · 金额格子默认空着，不预先填数
 * 客户只显示唛头，不带名字（2026-09-19「显示唛头就行了」）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  adminWalletDeduct,
  adminWalletReverse,
  adminWalletTopup,
  fetchStaffWalletClients,
  type StaffWalletClientItem,
  type StaffWalletLedgerItem,
} from "../../../services/business-api";
import { useLiveRefresh } from "../../../modules/realtime/useRealtime";
import ClientLedgerPanel, { beijingTime, yuan } from "../../../modules/wallet/ClientLedgerPanel";
import { useNarrowBox } from "../../../modules/wallet/useNarrowBox";
import {
  contentKeyOf,
  createUncertainStore,
  newSubmitKey,
  pickSubmitKey,
  SubmitOutcomeUnknownError,
  type AdjustContent,
} from "../../../modules/wallet/submit-keys";

/** 浏览器存储（隐私模式等拿不到就是 null，退回只在这一页里认） */
function browserStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

/** 金额格子：大于 0、最多两位小数；不合格给 null（跟后端同一个规矩） */
function parseAmountInput(raw: string): number | null {
  const t = raw.trim();
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

const PROOF_MAX = 8 * 1024 * 1024;

type Dialog =
  | { kind: "topup" | "deduct"; step: "fill" | "confirm"; submitKey: string }
  | { kind: "reverse"; row: StaffWalletLedgerItem; submitKey: string };

export default function AdminClientBalancePage() {
  const [keyword, setKeyword] = useState("");
  const [clients, setClients] = useState<StaffWalletClientItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedBalance, setSelectedBalance] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [toast, setToast] = useState("");
  // 窄（手机、平板带侧边栏）：客户列表一条一块，不用横着滚（2026-11-27）
  const { ref: listBoxRef, narrow } = useNarrowBox<HTMLElement>(640);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [amount, setAmount] = useState("");
  const [text, setText] = useState("");
  const [proof, setProof] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /**
   * 「不知道办成没有」的那几笔：内容 → 当时用的提交编号（2026-11-27 审查第 1 条，规矩见 modules/wallet/submit-keys.ts）。
   * 同样的内容再交（原样重试、返回修改没改、关掉重开填同一个数）都用回原来那个编号，后端认得出是同一笔，不会办两遍
   */
  const uncertain = useMemo(() => createUncertainStore(browserStorage()), []);

  const listSeq = useRef(0);
  const keywordRef = useRef(keyword);
  keywordRef.current = keyword;
  const loadClients = useCallback(async (opts?: { silent?: boolean }) => {
    const mine = ++listSeq.current;
    try {
      const data = await fetchStaffWalletClients(keywordRef.current);
      if (mine !== listSeq.current) return;
      setClients(data.clients);
      setLoaded(true);
      setListError("");
    } catch (e) {
      if (mine !== listSeq.current || opts?.silent) return;
      setListError(e instanceof Error ? e.message : "客户没加载出来");
    }
  }, []);
  useEffect(() => { void loadClients(); }, [loadClients]);
  useLiveRefresh({ topics: ["wallet", "consolidation", "whr"], refresh: () => loadClients({ silent: true }) });

  const selectedClient = useMemo(() => clients.find((c) => c.clientId === selected) ?? null, [clients, selected]);
  const currentBalance = selectedBalance ?? selectedClient?.balance ?? null;

  const openCreate = (kind: "topup" | "deduct") => {
    setAmount(""); // 金额默认空着，不预先填（老板 2026-11 定）
    setText("");
    setProof("");
    setDialogError("");
    setDialog({ kind, step: "fill", submitKey: newSubmitKey() });
  };
  const openReverse = (row: StaffWalletLedgerItem) => {
    setText("");
    setDialogError("");
    setDialog({ kind: "reverse", row, submitKey: newSubmitKey() });
  };
  const closeDialog = () => { if (!submitting) setDialog(null); };

  const onProofFile = (file: File | undefined) => {
    setDialogError("");
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp|bmp)$/.test(file.type)) { setDialogError("水单只收图片（png / jpg / gif / webp / bmp）"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      if (result.length > PROOF_MAX) { setDialogError("水单图片过大，请压缩后再上传"); return; }
      setProof(result);
    };
    reader.onerror = () => setDialogError("水单读取失败，请重试");
    reader.readAsDataURL(file);
  };

  const parsedAmount = parseAmountInput(amount);

  /** 第一步「下一步：核对」：格子都对了才进第二步 */
  const goConfirm = () => {
    if (!dialog || dialog.kind === "reverse") return;
    if (parsedAmount === null) { setDialogError("金额要大于 0，最多两位小数"); return; }
    if (text.length > 200) { setDialogError(`${dialog.kind === "topup" ? "备注" : "原因"}最多 200 个字`); return; }
    if (dialog.kind === "deduct") {
      if (!text.trim()) { setDialogError("请写减金额的原因"); return; }
      if (currentBalance !== null && parsedAmount > currentBalance) { setDialogError(`余额不够减：现在 ${yuan(currentBalance)}，要减 ${yuan(parsedAmount)}`); return; }
    }
    setDialogError("");
    setDialog({ ...dialog, step: "confirm" });
  };
  /** 回去改：换一个新编号备着；内容要是没改、又是之前「不知道办成没有」的那一笔，提交时还是用回原来那个（pickSubmitKey） */
  const backToFill = () => {
    if (!dialog || dialog.kind === "reverse") return;
    setDialogError("");
    setDialog({ kind: dialog.kind, step: "fill", submitKey: newSubmitKey() });
  };

  // 连点两下：状态还没来得及变，靠这个 ref 当场挡住第二下（挡不住的还有后端按提交编号去重）
  const submittingRef = useRef(false);
  const submit = async () => {
    if (!dialog || !selected || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setDialogError("");
    // 这一次填的内容 → 用哪个提交编号（之前「不知道办成没有」的同样内容用回原来那个）
    const content: AdjustContent = dialog.kind === "reverse"
      ? { kind: "reverse", adjustmentId: dialog.row.adjustment!.id, clientId: selected, text }
      : { kind: dialog.kind, clientId: selected, amount, text, proof };
    const ck = contentKeyOf(content);
    const submitKey = pickSubmitKey(uncertain, ck, dialog.submitKey);
    try {
      if (dialog.kind === "topup") {
        const r = await adminWalletTopup({ clientId: selected, amount: amount.trim(), remark: text.trim(), proofImage: proof, submitKey });
        uncertain.forget(ck);
        setToast(r.duplicate
          ? `这一笔刚才其实已经加过了（那次没收到回话，但办成了），这次没有重复加。现在余额 ${yuan(r.balanceAfter)}。真要再加一笔同样的数，请再打开弹窗提交一次`
          : `已给 ${selected} 加 ${yuan(r.adjustment.amount)}，现在余额 ${yuan(r.balanceAfter)}`);
        setSelectedBalance(r.balanceAfter);
      } else if (dialog.kind === "deduct") {
        const r = await adminWalletDeduct({ clientId: selected, amount: amount.trim(), reason: text.trim(), submitKey });
        uncertain.forget(ck);
        setToast(r.duplicate
          ? `这一笔刚才其实已经减过了（那次没收到回话，但办成了），这次没有重复减。现在余额 ${yuan(r.balanceAfter)}。真要再减一笔同样的数，请再打开弹窗提交一次`
          : `已从 ${selected} 的余额减 ${yuan(r.adjustment.amount)}，现在余额 ${yuan(r.balanceAfter)}`);
        setSelectedBalance(r.balanceAfter);
      } else if (dialog.kind === "reverse") {
        if (!text.trim()) { setDialogError("请写冲掉的原因"); return; }
        const r = await adminWalletReverse({ adjustmentId: dialog.row.adjustment!.id, clientId: selected, reason: text.trim(), submitKey });
        uncertain.forget(ck);
        setToast(r.duplicate
          ? `这一笔刚才其实已经冲掉了（那次没收到回话，但办成了），这次没有重复冲。现在余额 ${yuan(r.balanceAfter)}`
          : `已冲掉那一笔 ${yuan(r.amount)}，现在余额 ${yuan(r.balanceAfter)}${r.balanceAfter < 0 ? "（成了负数，财务系统会报警给老板）" : ""}`);
        setSelectedBalance(r.balanceAfter);
      }
      setDialog(null);
      setReloadKey((k) => k + 1);
      void loadClients({ silent: true });
    } catch (e) {
      if (e instanceof SubmitOutcomeUnknownError) {
        // 不知道办成没有：记下「这个内容 → 这个编号」，同样的内容再交还用它；流水和余额马上重拉一次给人看
        uncertain.remember(ck, submitKey);
        setDialogError(`${e.message}。关掉这个框就能看到流水`);
        setReloadKey((k) => k + 1);
        void loadClients({ silent: true });
      } else {
        // 后端明确说没办（带原因）：照原因改，改完再交就是新的一笔
        uncertain.forget(ck);
        setDialogError(e instanceof Error ? e.message : "没有办成，请稍后再试");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const box = { border: "1px solid var(--l-soft)", borderRadius: 12, padding: 16, background: "var(--white)", marginBottom: 14 } as const;
  const btn = { border: "1px solid var(--l-strong)", borderRadius: 8, padding: "6px 14px", background: "var(--white)", cursor: "pointer", fontSize: 13 } as const;
  const primary = { ...btn, border: "none", background: "var(--c-navy)", color: "var(--white)", fontWeight: 600 } as const;
  const th = { padding: "8px 12px", textAlign: "left" as const, fontWeight: 600, color: "var(--t-body)" };
  const input = { border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", fontSize: 14, width: "100%", boxSizing: "border-box" as const };

  return (
    <>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>客户余额</h1>
      <p style={{ fontSize: 13, color: "var(--t-muted)", margin: "0 0 14px" }}>
        客户只有这一个余额：集货拼柜付款当场扣，运费账单出来自动扣。客户线下转钱、你确认到账后在这里给他加；加了就算数，加错了在那一笔上点「冲掉」。
      </p>
      {toast ? (
        <div role="status" style={{ ...box, background: "var(--c-green-bg, #ecfdf5)", display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>{toast}</span>
          <button type="button" style={{ ...btn, whiteSpace: "nowrap", flexShrink: 0, alignSelf: "flex-start" }} onClick={() => setToast("")}>知道了</button>
        </div>
      ) : null}

      <section style={box} ref={listBoxRef}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <input aria-label="按唛头搜客户" value={keyword} onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void loadClients(); }}
            placeholder="按唛头搜…" style={{ ...input, width: 220 }} />
          <button type="button" style={btn} onClick={() => void loadClients()}>搜索</button>
        </div>
        {listError ? <p role="alert" style={{ color: "var(--c-red-deep)", fontSize: 13 }}>客户没加载出来：{listError}</p> : null}
        {!loaded && !listError ? <p style={{ color: "var(--t-muted)", fontSize: 13 }}>加载中…</p> : null}
        {loaded ? (
          <>
            <div style={{ fontSize: 12, color: "var(--t-strong)", marginBottom: 6 }}>共 {clients.length} 个客户</div>
            {narrow ? (
              <div style={{ display: "grid", gap: 8, maxHeight: 420, overflowY: "auto" }}>
                {clients.map((c) => (
                  <div key={c.clientId} style={{ border: "1px solid var(--l-soft)", borderRadius: 10, padding: "10px 12px", background: c.clientId === selected ? "var(--c-blue-bg)" : undefined }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <strong style={{ wordBreak: "break-all" }}>{c.clientId}</strong>
                      <strong style={{ whiteSpace: "nowrap", color: c.balance < 0 ? "var(--c-red-deep)" : undefined }}>{yuan(c.balance)}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                      <span style={{ fontSize: 12, color: "var(--t-muted)" }}>{c.status === "active" ? "正常" : "已封禁"} · {c.updatedAt ? beijingTime(c.updatedAt) : "没有过余额"}</span>
                      <button type="button" style={btn} onClick={() => { setSelected(c.clientId); setSelectedBalance(null); setToast(""); }}>看流水 / 调整</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
            <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto" }}>
              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--s-alt)", borderBottom: "1px solid var(--l-soft)" }}>
                    <th style={th}>唛头</th>
                    <th style={th}>状态</th>
                    <th style={{ ...th, textAlign: "right" }}>余额</th>
                    <th style={th}>最后变动</th>
                    <th style={th}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => (
                    <tr key={c.clientId} style={{ borderBottom: "1px solid var(--s-sunken)", background: c.clientId === selected ? "var(--c-blue-bg)" : undefined }}>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap", minWidth: 100 }}>{c.clientId}</td>
                      <td style={{ padding: "8px 12px" }}>{c.status === "active" ? "正常" : "已封禁"}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: c.balance < 0 ? "var(--c-red-deep)" : undefined }}>{yuan(c.balance)}</td>
                      <td style={{ padding: "8px 12px", color: "var(--t-muted)", whiteSpace: "nowrap" }}>{c.updatedAt ? beijingTime(c.updatedAt) : "—"}</td>
                      <td style={{ padding: "8px 12px" }}>
                        <button type="button" style={btn} onClick={() => { setSelected(c.clientId); setSelectedBalance(null); setToast(""); }}>看流水 / 调整</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </>
        ) : null}
      </section>

      {selected ? (
        <section style={box}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>唛头 {selected}</div>
              <div style={{ fontSize: 13, color: "var(--t-muted)" }}>
                现在余额：<strong style={{ color: currentBalance !== null && currentBalance < 0 ? "var(--c-red-deep)" : "var(--t-heading)" }}>{currentBalance === null ? "—" : yuan(currentBalance)}</strong>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" style={primary} onClick={() => openCreate("topup")}>给客户加金额</button>
              <button type="button" style={btn} onClick={() => openCreate("deduct")}>减金额</button>
            </div>
          </div>
          <ClientLedgerPanel clientId={selected} isAdmin reloadKey={reloadKey} onReverse={openReverse} onBalance={setSelectedBalance} />
        </section>
      ) : (
        <p style={{ color: "var(--t-muted)", fontSize: 13 }}>在上面选一个客户，看他的流水、给他加 / 减金额。</p>
      )}

      {dialog && selected ? (
        <div role="dialog" aria-modal="true" aria-label={dialog.kind === "topup" ? "给客户加金额" : dialog.kind === "deduct" ? "减金额" : "冲掉这一笔"}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "12px 12px calc(72px + env(safe-area-inset-bottom))" }}>
          {/* 手机上：弹窗最高占满屏、里面能滚；底下留出底部那排常用入口的高度（它压在页面最上层），按钮不会被挡住（2026-11-27） */}
          <div style={{ background: "var(--white)", borderRadius: 12, padding: 16, width: "100%", maxWidth: 440, maxHeight: "calc(100dvh - 84px - env(safe-area-inset-bottom))", overflowY: "auto", boxSizing: "border-box" }}>
            {dialog.kind === "reverse" ? (
              <>
                <h3 style={{ marginTop: 0 }}>冲掉这一笔管理员充值</h3>
                <div style={{ fontSize: 14, lineHeight: 1.8 }}>
                  <div>唛头：<strong>{selected}</strong></div>
                  <div>那一笔：<strong>{yuan(dialog.row.amount)}</strong>（{beijingTime(dialog.row.createdAt)}{dialog.row.remark ? `，备注：${dialog.row.remark}` : ""}）</div>
                  <div style={{ color: "var(--c-red-deep)", fontSize: 13 }}>
                    整笔冲掉，不能改数、不能冲一部分、冲了不能撤回。现在余额 {currentBalance === null ? "—" : yuan(currentBalance)}，
                    冲完 {currentBalance === null ? "—" : yuan(currentBalance - dialog.row.amount)}
                    {currentBalance !== null && currentBalance - dialog.row.amount < 0 ? "（会变成负数，照样冲；财务系统会报警给老板）" : ""}。
                  </div>
                </div>
                <label style={{ display: "block", marginTop: 10, fontSize: 13 }}>原因（必填，客户在流水里看得到）
                  <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={200} rows={2} style={{ ...input, marginTop: 4 }} />
                </label>
              </>
            ) : dialog.step === "fill" ? (
              <>
                <h3 style={{ marginTop: 0 }}>{dialog.kind === "topup" ? "给客户加金额" : "减金额（把余额退给客户）"}</h3>
                <div style={{ fontSize: 14, marginBottom: 8 }}>唛头：<strong>{selected}</strong>　现在余额：{currentBalance === null ? "—" : yuan(currentBalance)}</div>
                <label style={{ display: "block", fontSize: 13 }}>金额（元）
                  <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="填金额，最多两位小数" style={{ ...input, marginTop: 4 }} />
                </label>
                <label style={{ display: "block", marginTop: 10, fontSize: 13 }}>{dialog.kind === "topup" ? "备注（可不填，客户在流水里看得到）" : "原因（必填，客户在流水里看得到）"}
                  <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={200} rows={2} style={{ ...input, marginTop: 4 }} />
                </label>
                {dialog.kind === "topup" ? (
                  <label style={{ display: "block", marginTop: 10, fontSize: 13 }}>水单（可以不传）
                    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" onChange={(e) => onProofFile(e.target.files?.[0])} style={{ display: "block", marginTop: 4 }} />
                    {proof ? <img src={proof} alt="水单预览" style={{ maxWidth: 160, maxHeight: 120, marginTop: 6, display: "block" }} /> : null}
                  </label>
                ) : (
                  <p style={{ fontSize: 12, color: "var(--t-muted)", margin: "8px 0 0" }}>不能减成负数；钱请线下转给客户。</p>
                )}
              </>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>请再核对一遍</h3>
                {/* 加错了系统拦不住（老板很在意）：唛头和金额大字再显示一遍 */}
                <div style={{ fontSize: 15, lineHeight: 1.9, border: "1px solid var(--l-soft)", borderRadius: 10, padding: 12, background: "var(--s-alt)" }}>
                  <div style={{ wordBreak: "break-all" }}>唛头：<strong style={{ fontSize: 18 }}>{selected}</strong></div>
                  <div>{dialog.kind === "topup" ? "加" : "减"}：<strong style={{ fontSize: 22, color: dialog.kind === "topup" ? "var(--c-navy)" : "var(--c-red-deep)" }}>{parsedAmount === null ? "—" : yuan(parsedAmount)}</strong></div>
                  <div style={{ fontSize: 13 }}>
                    余额：{currentBalance === null ? "—" : yuan(currentBalance)} → {currentBalance === null || parsedAmount === null ? "—" : yuan(dialog.kind === "topup" ? currentBalance + parsedAmount : currentBalance - parsedAmount)}
                  </div>
                  <div style={{ fontSize: 13 }}>{dialog.kind === "topup" ? "备注" : "原因"}：{text.trim() || "（没写）"}</div>
                  {dialog.kind === "topup" ? <div style={{ fontSize: 13 }}>水单：{proof ? "已传" : "没传"}</div> : null}
                </div>
                <p style={{ fontSize: 12, color: "var(--t-muted)" }}>{dialog.kind === "topup" ? "加了就算数，马上到客户余额；运费账单会自动从这里扣。加错了只能整笔冲掉。" : "减了马上从余额里扣掉，请记得线下把钱转给客户。"}</p>
              </>
            )}
            {dialogError ? <p role="alert" style={{ color: "var(--c-red-deep)", fontSize: 13 }}>{dialogError}</p> : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              {dialog.kind !== "reverse" && dialog.step === "confirm" ? (
                <button type="button" style={btn} disabled={submitting} onClick={backToFill}>返回修改</button>
              ) : (
                <button type="button" style={btn} disabled={submitting} onClick={closeDialog}>取消</button>
              )}
              {dialog.kind !== "reverse" && dialog.step === "fill" ? (
                <button type="button" style={primary} onClick={goConfirm}>下一步：核对</button>
              ) : (
                <button type="button" style={{ ...primary, opacity: submitting ? 0.6 : 1, cursor: submitting ? "default" : "pointer" }} disabled={submitting} onClick={() => void submit()}>
                  {submitting ? "提交中…" : dialog.kind === "topup" ? "确认加金额" : dialog.kind === "deduct" ? "确认减金额" : "确认冲掉"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
