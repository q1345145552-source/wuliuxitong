/**
 * 代理申请（2026-11-08，老板：「财务提交，物流审批」）：给海外仓财务系统的那两条接口要用的纯函数 ——
 * 读请求体、读查询参数、拼返回的「申请」。不碰数据库，测试（test-agent-apply-source）直接跑。
 *
 * 规矩：
 *   · 文字一律去掉控制字符、去首尾空格再量长度；多传不认识的字段回 400（不悄悄忽略）。
 *   · 登录账号跟开代理同一个规则（validateAgentLoginId）；**交申请时不查账号有没有人用** ——
 *     不然海外仓那边能拿这个接口试探物流有哪些账号。撞了由超管审批时换。
 *   · 返回的「申请」逐个字段列（CLAUDE.md #31），不给代理价、密码、审批人、代理 id、仓号以外的东西。
 */
import { validateAgentLoginId } from "../agents/agent-rules";

/** 仓号存成 PostgreSQL integer */
export const WAREHOUSE_ID_MAX = 2_147_483_647;
/** 按仓查最多给几张（新的在前） */
export const APPLICATIONS_PER_WAREHOUSE_MAX = 20;
export const APPLICATION_PENDING_MESSAGE = "这个仓已经有一张在审的申请";

export interface AgentApplicationInput {
  warehouseId: number;
  warehouseName: string;
  submittedBy: string;
  agentName: string;
  contactName: string;
  contactPhone: string;
  loginId: string;
  remark: string | null;
}

const ALLOWED_KEYS = ["warehouseId", "warehouseName", "submittedBy", "agentName", "contactName", "contactPhone", "loginId", "remark"] as const;

/** 控制字符（C0、DEL、C1）去掉，再去首尾空格。不是字符串返回 null（调用方报「要是文字」） */
export function cleanApplyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
}

type TextRule = { key: keyof AgentApplicationInput; label: string; max: number; emptyMessage: string };
const REQUIRED_TEXT: TextRule[] = [
  { key: "warehouseName", label: "仓名", max: 100, emptyMessage: "请填仓名" },
  { key: "submittedBy", label: "提交人", max: 100, emptyMessage: "请填提交人" },
  // 跟开代理同一个上限（admin-routes.ts parseAgentCreateBody：最多 50 个字）
  { key: "agentName", label: "代理名字", max: 50, emptyMessage: "请填代理名字" },
  { key: "contactName", label: "联系人", max: 50, emptyMessage: "请填联系人" },
  { key: "contactPhone", label: "联系电话", max: 40, emptyMessage: "请填联系电话" },
];

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** POST 交申请的请求体 */
export function parseAgentApplicationBody(raw: unknown): ParseResult<AgentApplicationInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "请求内容要是一个 JSON 对象" };
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).filter((k) => !(ALLOWED_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) return { ok: false, message: `不认识的字段：${unknown.slice(0, 5).join("、")}` };

  const wid = body.warehouseId;
  if (wid === undefined || wid === null || wid === "") return { ok: false, message: "请填仓库编号" };
  if (typeof wid !== "number" || !Number.isInteger(wid) || wid < 1 || wid > WAREHOUSE_ID_MAX) {
    return { ok: false, message: "仓库编号要是正整数" };
  }

  const texts: Record<string, string> = {};
  for (const rule of REQUIRED_TEXT) {
    const v = body[rule.key];
    if (v === undefined || v === null) return { ok: false, message: rule.emptyMessage };
    const text = cleanApplyText(v);
    if (text === null) return { ok: false, message: `${rule.label}要是文字` };
    if (!text) return { ok: false, message: rule.emptyMessage };
    if (text.length > rule.max) return { ok: false, message: `${rule.label}太长了（最多 ${rule.max} 个字）` };
    texts[rule.key] = text;
  }

  const rawLogin = body.loginId;
  const loginId = rawLogin === undefined || rawLogin === null ? "" : cleanApplyText(rawLogin);
  if (loginId === null) return { ok: false, message: "登录账号要是文字" };
  const loginIssue = validateAgentLoginId(loginId);
  if (loginIssue) return { ok: false, message: loginIssue };

  let remark: string | null = null;
  if (body.remark !== undefined && body.remark !== null) {
    const text = cleanApplyText(body.remark);
    if (text === null) return { ok: false, message: "备注要是文字" };
    if (text.length > 500) return { ok: false, message: "备注太长了（最多 500 个字）" };
    remark = text || null;
  }

  return {
    ok: true,
    value: {
      warehouseId: wid,
      warehouseName: texts.warehouseName,
      submittedBy: texts.submittedBy,
      agentName: texts.agentName,
      contactName: texts.contactName,
      contactPhone: texts.contactPhone,
      loginId,
      remark,
    },
  };
}

/** GET ?warehouseId= 只认十进制正整数（不带正负号、小数点、空格、前导 0） */
export function parseWarehouseIdQuery(raw: unknown): ParseResult<number> {
  if (raw === undefined || raw === null || raw === "") return { ok: false, message: "请带上仓库编号 warehouseId" };
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,9}$/.test(raw)) return { ok: false, message: "仓库编号要是正整数" };
  const n = Number(raw);
  if (n > WAREHOUSE_ID_MAX) return { ok: false, message: "仓库编号要是正整数" };
  return { ok: true, value: n };
}

/** 数据库里一张申请（只取拼返回要用的那几样） */
export interface AgentApplicationRow {
  id: string;
  status: string;
  agentName: string;
  contactName: string;
  contactPhone: string;
  loginId: string;
  remark: string | null;
  /** 库里那一列叫 submitter_name（提交人不是物流员工账号），给财务时字段名照约定叫 submittedBy */
  submitterName: string;
  createdAt: Date;
  reviewedAt: Date | null;
  rejectReason: string | null;
  approvedLoginId: string | null;
}

/** 给海外仓财务系统的「申请」：就这 12 个字段（api-contract 第 26 节），一个不多 */
export interface FinanceAgentApplication {
  id: string;
  status: "pending" | "approved" | "rejected";
  agentName: string;
  contactName: string;
  contactPhone: string;
  loginId: string;
  remark: string | null;
  submittedBy: string;
  createdAt: string;
  reviewedAt: string | null;
  rejectReason: string | null;
  approvedLoginId: string | null;
}

/** 选库时只取这些列：跟 AgentApplicationRow 一一对应（submitterName 给财务时叫 submittedBy），代理 id、审批人、在审标记都不取 */
export const FINANCE_APPLICATION_SELECT = {
  id: true,
  status: true,
  agentName: true,
  contactName: true,
  contactPhone: true,
  loginId: true,
  remark: true,
  submitterName: true,
  createdAt: true,
  reviewedAt: true,
  rejectReason: true,
  approvedLoginId: true,
} as const;

function statusOf(raw: string): FinanceAgentApplication["status"] {
  return raw === "approved" || raw === "rejected" ? raw : "pending";
}

export function mapFinanceAgentApplication(row: AgentApplicationRow): FinanceAgentApplication {
  return {
    id: row.id,
    status: statusOf(row.status),
    agentName: row.agentName,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    loginId: row.loginId,
    remark: row.remark,
    submittedBy: row.submitterName,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    rejectReason: row.rejectReason,
    approvedLoginId: row.approvedLoginId,
  };
}
