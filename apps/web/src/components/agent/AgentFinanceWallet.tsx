"use client";

/**
 * 代理：我的钱包（2026-11-19，财务系统2 第 13 期；约定第 10 节、ADR 0130）。
 * 余额、流水、提现记录都是打开页面时从财务系统2 现取的，**只能看**：没有申请提现的按钮（现在提现由财务替代理录）。
 * 金额照财务给的原样显示（字符串，两位小数），负数标红；不显示客户价、代理价、收款、经手人、备注、驳回原因。
 * 跟「集货余额」（客户的集货钱包，2026-09-18 起对代理关着）不是一回事。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import {
  fetchFinanceWalletBalance,
  fetchFinanceWalletLedger,
  fetchFinanceWalletWithdrawals,
  type FinanceWalletLedgerItem,
  type FinanceWalletPage,
  type FinanceWalletState,
  type FinanceWalletWithdrawal,
} from "../../services/agent-api";
import { LoadState, Panel, SectionHeader, StatusTag, TableWrap, btn, fmtTime, mono, td, tdNum, th, useAgentLoad } from "./agent-ui";

/** "130.00" → "¥130.00"，"-50.00" → "-¥50.00" */
export function walletMoney(s: string): string {
  return s.startsWith("-") ? `-¥${s.slice(1)}` : `¥${s}`;
}

/** 变动：0 显示「—」，正的带 + */
export function walletChange(s: string): string {
  if (/^-?0\.00$/.test(s)) return "—";
  return s.startsWith("-") ? walletMoney(s) : `+${walletMoney(s)}`;
}

function moneyStyle(s: string, base: CSSProperties): CSSProperties {
  return s.startsWith("-") && !/^-0\.00$/.test(s) ? { ...base, color: "var(--c-red-deep)" } : base;
}

/** 拿不到数据时给代理看的话（不出现「接口」「密钥」这类词） */
export const WALLET_STATE_TEXT: Record<Exclude<FinanceWalletState, "ok">, { title: string; description: string }> = {
  notConfigured: { title: "钱包还没开通", description: "钱包功能还在准备中，开通后这里会显示你的待结算、可用余额和提现记录。有问题请联系湘泰。" },
  notFound: { title: "还没有钱包记录", description: "你名下客户的账单出了以后，差价会记到这里。有问题请联系湘泰。" },
  unreachable: { title: "暂时取不到钱包数据", description: "财务系统暂时连不上，请过一会儿点「刷新」再看。一直这样请联系湘泰。" },
};

type ListState<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
  error: string;
  state: FinanceWalletState | null;
};

/** 分页列表（最新的在上，「加载更多」往下接）。只认最后一次请求的结果，刷新时旧的翻页回来不许接上去 */
function usePagedList<T>(fetchPage: (cursor?: string | null) => Promise<{ state: FinanceWalletState; page?: FinanceWalletPage<T> }>) {
  const [list, setList] = useState<ListState<T>>({ items: [], nextCursor: null, hasMore: false, loading: true, error: "", state: null });
  const seq = useRef(0);
  const load = useCallback(async (cursor: string | null) => {
    const mine = ++seq.current;
    setList((cur) => ({ ...cur, loading: true, error: "", ...(cursor ? {} : { items: [], nextCursor: null, hasMore: false, state: null }) }));
    try {
      const r = await fetchPage(cursor);
      if (mine !== seq.current) return;
      if (r.state !== "ok" || !r.page) {
        setList((cur) => ({ ...cur, loading: false, state: r.state, ...(cursor ? {} : { items: [] }) }));
        return;
      }
      const page = r.page;
      setList((cur) => ({
        items: cursor ? [...cur.items, ...page.items] : page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        loading: false,
        error: "",
        state: "ok",
      }));
    } catch (e) {
      if (mine !== seq.current) return;
      setList((cur) => ({ ...cur, loading: false, error: e instanceof Error ? e.message : "加载失败" }));
    }
  }, [fetchPage]);
  useEffect(() => {
    void load(null);
    return () => { seq.current++; };
  }, [load]);
  return { list, reload: () => load(null), more: () => (list.nextCursor ? load(list.nextCursor) : undefined) };
}

function MoreButton({ hasMore, loading, onMore, count }: { hasMore: boolean; loading: boolean; onMore: () => void; count: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, fontSize: 13, color: "var(--t-muted)" }}>
      <span>已显示 {count} 条{hasMore ? "，后面还有" : "，就这些"}</span>
      {hasMore ? <button type="button" style={btn} onClick={onMore} disabled={loading}>{loading ? "加载中…" : "加载更多"}</button> : null}
    </div>
  );
}

function LedgerTable({ items }: { items: FinanceWalletLedgerItem[] }) {
  return (
    <TableWrap label="钱包流水，可横向滚动">
      <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 960 }}>
        <thead>
          <tr>
            <th scope="col" style={th}>时间</th>
            <th scope="col" style={th}>种类</th>
            <th scope="col" style={th}>运单号</th>
            <th scope="col" style={th}>唛头</th>
            <th scope="col" style={th}>账单号</th>
            <th scope="col" style={{ ...th, textAlign: "right" }}>待结算变动</th>
            <th scope="col" style={{ ...th, textAlign: "right" }}>可用余额变动</th>
            <th scope="col" style={{ ...th, textAlign: "right" }}>之后待结算</th>
            <th scope="col" style={{ ...th, textAlign: "right" }}>之后可用余额</th>
          </tr>
        </thead>
        <tbody>
          {items.map((l) => (
            <tr key={l.seq}>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtTime(l.createdAt)}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{l.kindLabel}{l.withdrawalId ? <span style={{ color: "var(--t-muted)" }}>（提现 {l.withdrawalId}）</span> : null}</td>
              <td style={{ ...td, ...mono }}>{l.waybillNo ?? "—"}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{l.customerMark ?? "—"}</td>
              <td style={{ ...td, ...mono }}>{l.billNo ?? "—"}</td>
              <td style={moneyStyle(l.pendingChange, tdNum)}>{walletChange(l.pendingChange)}</td>
              <td style={moneyStyle(l.availableChange, tdNum)}>{walletChange(l.availableChange)}</td>
              <td style={moneyStyle(l.pendingAfter, tdNum)}>{walletMoney(l.pendingAfter)}</td>
              <td style={moneyStyle(l.availableAfter, tdNum)}>{walletMoney(l.availableAfter)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function WithdrawalTable({ items }: { items: FinanceWalletWithdrawal[] }) {
  return (
    <TableWrap label="提现记录，可横向滚动">
      <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
        <thead>
          <tr>
            <th scope="col" style={th}>提现编号</th>
            <th scope="col" style={{ ...th, textAlign: "right" }}>金额</th>
            <th scope="col" style={th}>状态</th>
            <th scope="col" style={th}>申请时间</th>
            <th scope="col" style={th}>审批时间</th>
            <th scope="col" style={th}>付款日期</th>
          </tr>
        </thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.withdrawalId}>
              <td style={{ ...td, ...mono }}>{w.withdrawalId}</td>
              <td style={tdNum}>{walletMoney(w.amount)}</td>
              <td style={td}>
                <StatusTag status={w.status === "paid" ? "paid" : w.status === "rejected" || w.status === "voided" ? "cancelled" : "unpaid"} label={w.statusLabel} />
                {w.voidedAt ? <div style={{ fontSize: 12, color: "var(--t-muted)", marginTop: 2 }}>作废：{fmtTime(w.voidedAt)}</div> : null}
              </td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtTime(w.requestedAt)}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtTime(w.decidedAt)}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{w.paidOn ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div style={{ flex: "1 1 180px", minWidth: 160, padding: "12px 14px", border: "1px solid var(--l-soft)", borderRadius: 8, background: "var(--white)" }}>
      <div style={{ fontSize: 13, color: "var(--t-muted)" }}>{label}</div>
      <div style={moneyStyle(value, { fontSize: 22, fontWeight: 700, marginTop: 4, fontVariantNumeric: "tabular-nums", color: "var(--t-heading)" })}>{walletMoney(value)}</div>
      <div style={{ fontSize: 12, color: "var(--t-faint)", marginTop: 4 }}>{hint}</div>
    </div>
  );
}

export default function AgentFinanceWallet() {
  const balance = useAgentLoad(fetchFinanceWalletBalance, []);
  const ledger = usePagedList(fetchFinanceWalletLedger);
  const withdrawals = usePagedList(fetchFinanceWalletWithdrawals);
  const refreshAll = () => { balance.reload(); void ledger.reload(); void withdrawals.reload(); };
  const state = balance.data?.state;
  const b = balance.data?.balance;

  return (
    <section>
      <SectionHeader
        title="我的钱包"
        desc="名下客户的账单出了，差价先记在「待结算」；客户的钱到账后转进「可用余额」。要提现请联系湘泰财务。时间按北京时间显示。"
        actions={<button type="button" style={btn} onClick={refreshAll} disabled={balance.loading}>刷新</button>}
      />
      <LoadState loading={balance.loading && !balance.data} error={balance.error} onRetry={balance.reload} />
      {state && state !== "ok" ? <EmptyStateCard {...WALLET_STATE_TEXT[state]} /> : null}
      {state === "ok" && b ? (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <Tile label="可用余额" value={b.available} hint="能提现的钱。是负数的话湘泰会跟你联系" />
            <Tile label="待结算" value={b.pending} hint="客户还没付钱的差价，付了会转进可用余额" />
            <Tile label="已提现" value={b.withdrawn} hint="一共付给你的" />
          </div>
          <Panel title="流水">
            <LoadState loading={ledger.list.loading && ledger.list.items.length === 0} error={ledger.list.error} onRetry={() => void ledger.reload()} />
            {ledger.list.state && ledger.list.state !== "ok" ? <EmptyStateCard {...WALLET_STATE_TEXT[ledger.list.state]} /> : null}
            {ledger.list.state === "ok" && ledger.list.items.length === 0 ? <EmptyStateCard title="还没有流水" description="名下客户的账单出了以后，这里会一笔一笔记下来。" /> : null}
            {ledger.list.items.length > 0 ? (
              <>
                <LedgerTable items={ledger.list.items} />
                <MoreButton hasMore={ledger.list.hasMore} loading={ledger.list.loading} onMore={() => void ledger.more()} count={ledger.list.items.length} />
              </>
            ) : null}
          </Panel>
          <Panel title="提现记录">
            <LoadState loading={withdrawals.list.loading && withdrawals.list.items.length === 0} error={withdrawals.list.error} onRetry={() => void withdrawals.reload()} />
            {withdrawals.list.state && withdrawals.list.state !== "ok" ? <EmptyStateCard {...WALLET_STATE_TEXT[withdrawals.list.state]} /> : null}
            {withdrawals.list.state === "ok" && withdrawals.list.items.length === 0 ? <EmptyStateCard title="还没有提现记录" description="要提现请联系湘泰财务，录进去以后这里能看到进度。" /> : null}
            {withdrawals.list.items.length > 0 ? (
              <>
                <WithdrawalTable items={withdrawals.list.items} />
                <MoreButton hasMore={withdrawals.list.hasMore} loading={withdrawals.list.loading} onMore={() => void withdrawals.more()} count={withdrawals.list.items.length} />
              </>
            ) : null}
          </Panel>
        </>
      ) : null}
    </section>
  );
}
