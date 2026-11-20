"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getOptionalSession } from "../../auth/auth-session";
import {
  FINANCE2_HOLD_EVENT,
  fetchFinance2HoldStatus,
  fetchFinance2ObserveLog,
  recheckFinance2Hold,
  refreshFinance2HoldList,
  type Finance2HoldStatus,
  type Finance2ObserveLog,
} from "../../services/finance2-holds-api";

/**
 * 放货页上的「扣货名单」一块（2026-11-19，财务系统2 第 9 期；约定 5.3）。放在装柜管理、尾端派送（管理员 / 员工 / 整柜）上面。
 * - 开关关着：什么都不显示。
 * - 写明「按几点的名单」；没有名单 / 超过 1 天没更新 / 最近连不上财务系统时黄条提示（老板 2026-11-19 定）。
 * - 「我刚才被拦的」每票一个「重新核对」，实时问财务系统2；也能自己输运单号核对。
 * - 后端拦货时（报错以【扣货】开头）core-api 发事件，这里马上刷新。
 * - 试运行（observe）时管理员能点开「试运行记录」：最近 7 天本来会拦谁（唛头、运单号、入口、几点、按几点的名单），
 *   看几天确认名单没算错，老板说开再改 enforce（老板 2026-11-19 答「放货拦截 4」）。员工看不到这个列表。
 * 不显示金额（名单里本来就没有），客户只显示唛头。
 */
export function Finance2HoldPanel() {
  const [status, setStatus] = useState<Finance2HoldStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [checking, setChecking] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { blocked: boolean; message: string }>>({});
  const [manualNo, setManualNo] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");
  const [flash, setFlash] = useState(false);
  const [observeOpen, setObserveOpen] = useState(false);
  const [observeLog, setObserveLog] = useState<Finance2ObserveLog | null>(null);
  const [observeLoading, setObserveLoading] = useState(false);
  const [observeError, setObserveError] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);
  const timerRef = useRef<number | null>(null);
  /** 拿到过一次「开着」的状态才显示报错：开关 off（或后端还没上这个接口）时取不到也一声不吭 */
  const everLive = useRef(false);
  const isAdmin = getOptionalSession()?.role === "admin";

  const pollMsRef = useRef(0);
  const loadRef = useRef<() => void>(() => {});
  /** 换轮询间隔：一样就不动 */
  const schedule = useCallback((ms: number) => {
    if (pollMsRef.current === ms && timerRef.current !== null) return;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    pollMsRef.current = ms;
    timerRef.current = window.setInterval(() => { if (document.visibilityState === "visible") loadRef.current(); }, ms);
  }, []);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await fetchFinance2HoldStatus();
      if (mine !== seq.current) return;
      setStatus(next);
      setLoadError("");
      // 开关关着：改成 10 分钟问一次（页面开着时后台打开了开关，最多 10 分钟这一块就出来）；开着：1 分钟一次
      schedule(next.mode === "off" ? OFF_POLL_MS : ON_POLL_MS);
      if (next.mode !== "off") everLive.current = true;
    } catch (e) {
      if (mine !== seq.current) return;
      if (everLive.current) setLoadError(e instanceof Error ? e.message : "扣货名单状态没取到");
      schedule(everLive.current ? ON_POLL_MS : OFF_POLL_MS);
    }
  }, [schedule]);
  loadRef.current = () => { void load(); };

  useEffect(() => {
    void load();
    const onBlocked = () => {
      void load();
      setFlash(true);
      window.setTimeout(() => setFlash(false), 3000);
      boxRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    };
    window.addEventListener(FINANCE2_HOLD_EVENT, onBlocked);
    return () => {
      seq.current++; // 还在路上的那次回来也不再排下一轮（不然页面关了还留着定时器）
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      window.removeEventListener(FINANCE2_HOLD_EVENT, onBlocked);
    };
  }, [load]);

  const recheck = async (trackingNo: string) => {
    const no = trackingNo.trim();
    if (!no || checking) return;
    setChecking(no);
    try {
      const r = await recheckFinance2Hold(no);
      setResults((cur) => ({ ...cur, [no]: { blocked: r.blocked, message: r.message } }));
      if (!r.blocked) void load();
    } catch (e) {
      setResults((cur) => ({ ...cur, [no]: { blocked: true, message: e instanceof Error ? e.message : "核对没成功" } }));
    } finally {
      setChecking(null);
    }
  };

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshMsg("");
    try {
      const r = await refreshFinance2HoldList();
      setRefreshMsg(r.replaced ? `已更新：扣 ${r.holds ?? 0} 家，单票放行 ${r.released ?? 0} 票` : r.note ?? "已取到，名单没变");
      await load();
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : "没取到");
    } finally {
      setRefreshing(false);
    }
  };

  /** 点开 / 刷新试运行记录（只在点的时候取，不跟着 1 分钟轮询） */
  const loadObserveLog = async () => {
    if (observeLoading) return;
    setObserveLoading(true);
    setObserveError("");
    try {
      setObserveLog(await fetchFinance2ObserveLog());
    } catch (e) {
      setObserveError(e instanceof Error ? e.message : "试运行记录没取到");
    } finally {
      setObserveLoading(false);
    }
  };
  const toggleObserve = () => {
    const next = !observeOpen;
    setObserveOpen(next);
    if (next) void loadObserveLog();
  };

  if (!status && !loadError) return null;
  if (status?.mode === "off") return null;

  /** 走到这里只剩开着的（observe / enforce）或者还没取到状态（只有报错） */
  const live = status as Exclude<Finance2HoldStatus, { mode: "off" }> | null;
  const warnings: string[] = [];
  if (live) {
    if (live.notice) warnings.push(live.notice);
    if (live.lastErrorAt && (!live.fetchedAt || live.lastErrorAt > live.fetchedAt) && live.listLabel) {
      warnings.push(`最近一次（${live.lastErrorLabel}）没连上财务系统，现在${live.listLabel}拦。`);
    }
  }
  const recent = live ? live.recent : [];

  return (
    <div
      ref={boxRef}
      data-testid="finance2-hold-panel"
      style={{
        border: `1px solid ${flash ? "var(--c-red-2)" : "var(--l-soft)"}`, borderRadius: 8, padding: "10px 12px", marginBottom: 12,
        background: "var(--white)", fontSize: 13, color: "var(--t-body)", transition: "border-color .3s",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <strong style={{ color: "var(--t-strong)" }}>扣货名单</strong>
        {live && (
          <span style={{ color: "var(--t-muted)" }}>
            {live.listLabel ? `现在${live.listLabel}拦` : "还没有名单"}
            {live.mode === "observe" ? "（试运行：只记不拦）" : ""}
          </span>
        )}
        {loadError && <span style={{ color: "var(--c-red-deep)" }}>{loadError}</span>}
        {isAdmin && (
          <button type="button" onClick={refresh} disabled={refreshing} style={btn}>
            {refreshing ? "更新中…" : "立即更新名单"}
          </button>
        )}
        {refreshMsg && <span style={{ color: "var(--t-muted)" }}>{refreshMsg}</span>}
      </div>

      {isAdmin && live?.mode === "observe" && (
        <div style={{ marginTop: 6 }}>
          <button type="button" onClick={toggleObserve} style={btn} data-testid="finance2-observe-toggle">
            {observeOpen ? "收起试运行记录" : "试运行记录：这几天本来会拦谁"}
          </button>
          {observeOpen && (
            <div data-testid="finance2-observe-log" style={{ marginTop: 6 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", color: "var(--t-muted)" }}>
                <span>
                  最近 {observeLog?.days ?? 7} 天试运行期间本来会拦、没拦的（只记不拦）。核对几天没算错，老板说开再把开关改成 enforce。
                </span>
                <button type="button" onClick={() => void loadObserveLog()} disabled={observeLoading} style={btn}>
                  {observeLoading ? "取记录中…" : "刷新"}
                </button>
              </div>
              {observeError && <div style={{ marginTop: 4, color: "var(--c-red-deep)" }}>{observeError}</div>}
              {observeLog && observeLog.rows.length === 0 && !observeLoading && (
                <div style={{ marginTop: 4, color: "var(--t-faint)" }}>最近 {observeLog.days} 天没有本来会拦的货。</div>
              )}
              {observeLog && observeLog.rows.length > 0 && (
                <div style={{ marginTop: 4, overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: 560 }}>
                    <thead>
                      <tr style={{ color: "var(--t-muted)", textAlign: "left" }}>
                        <th style={cell}>几点（泰国时间）</th>
                        <th style={cell}>唛头</th>
                        <th style={cell}>运单号</th>
                        <th style={cell}>从哪个入口</th>
                        <th style={cell}>按的名单</th>
                      </tr>
                    </thead>
                    <tbody>
                      {observeLog.rows.map((r) => (
                        <tr key={r.id} style={{ borderTop: "1px dashed var(--l-soft)" }}>
                          <td style={cell}>{r.atLabel}</td>
                          <td style={{ ...cell, minWidth: 100 }}>{r.customerMark ?? "—"}</td>
                          <td style={{ ...cell, minWidth: 100 }}>
                            {r.trackingNo ?? "—"}
                            {r.waybillNo && r.trackingNo && r.waybillNo !== r.trackingNo ? `（母单 ${r.waybillNo}）` : ""}
                          </td>
                          <td style={cell}>{r.entry ?? "—"}</td>
                          <td style={cell}>{r.listLabel ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {observeLog.truncated && <div style={{ marginTop: 4, color: "var(--t-faint)" }}>只列最近 {observeLog.rows.length} 条。</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {warnings.map((w) => (
        <div key={w} style={{ marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--c-amber-bg)", color: "var(--c-amber-deep)" }}>{w}</div>
      ))}

      {recent.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: "var(--t-muted)", marginBottom: 4 }}>
            {recent.some((r) => !r.observed) ? "你刚才被拦下的货（这家客户有欠款，放货前请联系财务；钱付了可以点「重新核对」）：" : "试运行期间本来会拦的货："}
          </div>
          {recent.map((r) => (
            <div key={r.trackingNo} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "4px 0", borderTop: "1px dashed var(--l-soft)" }}>
              <span style={{ whiteSpace: "nowrap", fontWeight: 600, color: "var(--t-strong)" }}>{r.trackingNo}</span>
              <span style={{ whiteSpace: "nowrap" }}>唛头 {r.customerMark}</span>
              {r.entry && <span style={{ color: "var(--t-faint)" }}>{r.entry}</span>}
              <button type="button" onClick={() => recheck(r.trackingNo)} disabled={checking !== null} style={btn}>
                {checking === r.trackingNo ? "核对中…" : "重新核对"}
              </button>
              {results[r.trackingNo] && (
                <span style={{ color: results[r.trackingNo]!.blocked ? "var(--c-red-deep)" : "var(--c-green)" }}>{results[r.trackingNo]!.message}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 核对过、已经不在「刚才被拦的」里的（核对放行了就会掉出去）：结果留在这里，不一闪就没 */}
      {Object.entries(results).filter(([no]) => !recent.some((r) => r.trackingNo === no) && no !== manualNo.trim()).map(([no, r]) => (
        <div key={`done-${no}`} style={{ marginTop: 4, color: r.blocked ? "var(--c-red-deep)" : "var(--c-green)" }}>
          {no}：{r.message}
        </div>
      ))}

      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <input
          value={manualNo}
          onChange={(e) => setManualNo(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void recheck(manualNo); }}
          placeholder="输运单号重新核对"
          style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 8px", minWidth: 160, fontSize: 13 }}
        />
        <button type="button" onClick={() => recheck(manualNo)} disabled={checking !== null || !manualNo.trim()} style={btn}>
          {checking && checking === manualNo.trim() ? "核对中…" : "重新核对"}
        </button>
        {manualNo.trim() && results[manualNo.trim()] && !recent.some((r) => r.trackingNo === manualNo.trim()) && (
          <span style={{ color: results[manualNo.trim()]!.blocked ? "var(--c-red-deep)" : "var(--c-green)" }}>{results[manualNo.trim()]!.message}</span>
        )}
      </div>
    </div>
  );
}

/** 开着：1 分钟问一次状态；关着 / 取不到：10 分钟一次（关着也不完全停，免得后台打开了开关、开着的页面一直不知道） */
const ON_POLL_MS = 60_000;
const OFF_POLL_MS = 10 * 60_000;

/** 表格格子：编号类不换行（AGENTS.md 第 18 条） */
const cell: React.CSSProperties = { padding: "3px 8px", whiteSpace: "nowrap", verticalAlign: "top" };

const btn: React.CSSProperties = {
  border: "1px solid var(--c-blue)", color: "var(--c-blue)", background: "var(--white)", borderRadius: 6,
  padding: "3px 10px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
};
