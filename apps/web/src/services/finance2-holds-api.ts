import { apiBaseUrl, apiRequest } from "./core-api";

/** 放货页「扣货名单」那一块（2026-11-19，财务系统2 第 9 期）。后端 apps/api/src/modules/finance2-holds/routes.ts */

export interface Finance2HoldRecent {
  trackingNo: string;
  motherTrackingNo: string;
  /** 唛头（只显示唛头，不显示客户名字） */
  customerMark: string;
  entry: string | null;
  at: string;
  /** 试运行时「本来会拦、没拦」的 */
  observed: boolean;
}

export type Finance2HoldStatus =
  | { mode: "off" }
  | {
      mode: "observe" | "enforce";
      listGeneratedAt: string | null;
      listLabel: string | null;
      fetchedAt: string | null;
      lastError: string | null;
      lastErrorAt: string | null;
      lastErrorLabel: string | null;
      notice: string | null;
      recent: Finance2HoldRecent[];
    };

export interface Finance2RecheckResult {
  trackingNo: string;
  blocked: boolean;
  unreachable?: boolean;
  message: string;
}

/** 后端拦货时回的话以它开头（gate.ts HOLD_MESSAGE_MARK），core-api 见到就通知「扣货名单」那一块刷新 */
export const FINANCE2_HOLD_MESSAGE_MARK = "【扣货】";
export const FINANCE2_HOLD_EVENT = "finance2-hold-blocked";

export function fetchFinance2HoldStatus(): Promise<Finance2HoldStatus> {
  return apiRequest(`${apiBaseUrl()}/admin/finance2-holds/status`, { method: "GET" });
}

export function recheckFinance2Hold(trackingNo: string): Promise<Finance2RecheckResult> {
  return apiRequest(`${apiBaseUrl()}/admin/finance2-holds/recheck`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trackingNo }),
  });
}

export function refreshFinance2HoldList(): Promise<{ kind: string; replaced?: boolean; holds?: number; released?: number; note?: string }> {
  return apiRequest(`${apiBaseUrl()}/admin/finance2-holds/refresh`, { method: "POST" });
}

/** 试运行（observe）记录的一行：只有唛头、运单号、入口、时间，没有金额、没有客户名字 */
export interface Finance2ObserveRow {
  id: string;
  customerMark: string | null;
  trackingNo: string | null;
  waybillNo: string | null;
  entry: string | null;
  at: string;
  /** 泰国时间 */
  atLabel: string;
  /** 「按 … 的名单」 */
  listLabel: string | null;
}

export interface Finance2ObserveLog {
  mode: "off" | "observe" | "enforce";
  days: number;
  truncated: boolean;
  rows: Finance2ObserveRow[];
}

/** 试运行这几天「本来会拦谁」（只给管理员） */
export function fetchFinance2ObserveLog(): Promise<Finance2ObserveLog> {
  return apiRequest(`${apiBaseUrl()}/admin/finance2-holds/observe-log`, { method: "GET" });
}
