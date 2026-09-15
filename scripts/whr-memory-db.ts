/**
 * 仓库版 / 普通版集货路由自测用的「内存数据库」（2026-09-16，B1）。**一次都不连数据库。**
 *
 * 给 test-whr-long-term-price.ts、test-delete-after-shipped.ts 共用：
 *   · 按 Prisma 的 where / select / include / orderBy / take 语义在内存里查（只实现这两套路由真用到的那些）
 *   · 每一次加锁、写库都按发生顺序记进 mem.events，用来断言锁序、断言「被拦下时什么都没写」
 *   · mem.onEvent：某个事件发生的那一刻改数据，模拟「事务外判断之后、锁住之前，别人改了」（CLAUDE.md #28）
 *   · 手写 SQL 只认路由里真出现的那几条，认不出来直接抛错 —— 路由多写了一条 SQL 就该来这里看一眼
 *
 * ⚠️ 用法：先 installMemoryPrisma()，**再** import 路由模块（db/prisma.ts 在 import 时读 globalThis.__prisma）。
 * ⚠️ 这个文件名故意不叫 test-*.ts：它不是一个测试，不进 package.json；被测试 import，照样过 typecheck:scripts。
 */
import assert from "node:assert/strict";

export type Row = Record<string, any>;
export type Handler = (req: any, res: any) => Promise<void> | void;

export const MODELS = [
  "user",
  "agent",
  "clientWhrPrice",
  "whrConsolidationPlan",
  "whrConsolidationPlanCustomer",
  "whrConsolidationPrealert",
  "whrConsolidationPrealertItem",
  "whrConsolidationStatusLog",
  "consolidationBalanceLedger",
  "clientWalletAccount",
  "order",
  "consolidationTask",
  "consolidationPrealert",
  "consolidationPrealertProduct",
  "consolidationStatusLog",
] as const;

export const mem: {
  db: Record<string, Row[]>;
  events: string[];
  onEvent: ((event: string) => void) | null;
  seq: number;
} = { db: {}, events: [], onEvent: null, seq: 0 };

export function resetMemory(): void {
  mem.events = [];
  mem.onEvent = null;
  mem.seq = 0;
  for (const m of MODELS) mem.db[m] = [];
}

function emit(event: string): void {
  mem.events.push(event);
  mem.onEvent?.(event);
}

interface Rel {
  model: string;
  local: string;
  foreign: string;
  many: boolean;
}

/** 关系表：只配这两套路由用到的 */
const REL: Record<string, Record<string, Rel>> = {
  user: {
    agent: { model: "agent", local: "agentId", foreign: "id", many: false },
    whrPrice: { model: "clientWhrPrice", local: "id", foreign: "clientId", many: false },
  },
  clientWhrPrice: {
    client: { model: "user", local: "clientId", foreign: "id", many: false },
  },
  whrConsolidationPlan: {
    customers: { model: "whrConsolidationPlanCustomer", local: "id", foreign: "planId", many: true },
  },
  whrConsolidationPlanCustomer: {
    plan: { model: "whrConsolidationPlan", local: "planId", foreign: "id", many: false },
    client: { model: "user", local: "clientId", foreign: "id", many: false },
    prealerts: { model: "whrConsolidationPrealert", local: "id", foreign: "customerId", many: true },
  },
  whrConsolidationPrealert: {
    planCustomer: { model: "whrConsolidationPlanCustomer", local: "customerId", foreign: "id", many: false },
    items: { model: "whrConsolidationPrealertItem", local: "id", foreign: "prealertId", many: true },
    statusLogs: { model: "whrConsolidationStatusLog", local: "id", foreign: "prealertId", many: true },
  },
  whrConsolidationPrealertItem: {
    prealert: { model: "whrConsolidationPrealert", local: "prealertId", foreign: "id", many: false },
  },
  consolidationTask: {
    prealerts: { model: "consolidationPrealert", local: "id", foreign: "taskId", many: true },
  },
};

/** 删一行时跟着删的子表（照 schema 里的 onDelete: Cascade） */
const CASCADE: Record<string, Array<[string, string]>> = {
  whrConsolidationPlan: [["whrConsolidationPlanCustomer", "planId"]],
  whrConsolidationPlanCustomer: [["whrConsolidationPrealert", "customerId"]],
  whrConsolidationPrealert: [
    ["whrConsolidationPrealertItem", "prealertId"],
    ["whrConsolidationStatusLog", "prealertId"],
  ],
  consolidationTask: [
    ["consolidationPrealert", "taskId"],
    ["consolidationStatusLog", "taskId"],
  ],
  consolidationPrealert: [["consolidationPrealertProduct", "prealertId"]],
};

const isPlainObject = (v: unknown): v is Row =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

function matchScalar(value: unknown, cond: unknown): boolean {
  if (isPlainObject(cond)) {
    for (const [op, arg] of Object.entries(cond)) {
      if (arg === undefined) continue;
      if (op === "in") {
        if (!(arg as unknown[]).includes(value)) return false;
      } else if (op === "notIn") {
        if ((arg as unknown[]).includes(value)) return false;
      } else if (op === "not") {
        if (isPlainObject(arg) ? matchScalar(value, arg) : value === arg) return false;
      } else if (op === "equals") {
        if (value !== arg) return false;
      } else if (op === "startsWith") {
        if (typeof value !== "string" || !value.startsWith(String(arg))) return false;
      } else {
        throw new Error(`内存库不认识的查询条件 ${op}`);
      }
    }
    return true;
  }
  return value === cond;
}

function matches(model: string, row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue; // Prisma 里 undefined = 不加条件
    if (key === "OR") {
      if (!(cond as Row[]).some((w) => matches(model, row, w))) return false;
      continue;
    }
    if (key === "AND") {
      if (!(cond as Row[]).every((w) => matches(model, row, w))) return false;
      continue;
    }
    const rel = REL[model]?.[key];
    if (rel) {
      if (rel.many) throw new Error(`内存库没实现一对多关系过滤 ${model}.${key}`);
      const hit = mem.db[rel.model].find((r) => r[rel.foreign] === row[rel.local]);
      if (cond === null) {
        if (hit) return false;
        continue;
      }
      if (!hit || !matches(rel.model, hit, cond as Row)) return false;
      continue;
    }
    // 复合唯一键：clientId_currency: { clientId, currency }
    if (!(key in row) && isPlainObject(cond) && key.includes("_")) {
      if (!matches(model, row, cond)) return false;
      continue;
    }
    if (!matchScalar(row[key], cond)) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [key, dir] = Object.entries(spec)[0];
      const av = a[key] instanceof Date ? a[key].getTime() : a[key];
      const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
      if (av === bv) continue;
      const cmp = av > bv ? 1 : -1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

function countRel(model: string, row: Row, spec: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries((spec.select ?? {}) as Row)) {
    if (!v) continue;
    const rel = REL[model]?.[k];
    if (!rel) throw new Error(`内存库没配关系 ${model}.${k}（_count 用到）`);
    out[k] = mem.db[rel.model].filter((r) => r[rel.foreign] === row[rel.local]).length;
  }
  return out;
}

function related(model: string, row: Row, key: string, args: unknown): unknown {
  const rel = REL[model]?.[key];
  if (!rel) throw new Error(`内存库没配关系 ${model}.${key}`);
  const sub: Row = args === true ? {} : (args as Row);
  if (rel.many) {
    let rows = mem.db[rel.model].filter((r) => r[rel.foreign] === row[rel.local]);
    rows = rows.filter((r) => matches(rel.model, r, sub.where));
    rows = sortRows(rows, sub.orderBy);
    if (typeof sub.take === "number") rows = rows.slice(0, sub.take);
    return rows.map((r) => shape(rel.model, r, sub));
  }
  const hit = mem.db[rel.model].find((r) => r[rel.foreign] === row[rel.local]);
  return hit ? shape(rel.model, hit, sub) : null;
}

/** 按 select / include 裁剪：select 里没选的字段拿不到（跟真 Prisma 一样），include 带整行标量 */
function shape(model: string, row: Row, args: Row = {}): Row {
  const out: Row = {};
  if (args.select) {
    for (const [k, v] of Object.entries(args.select as Row)) {
      if (!v) continue;
      if (k === "_count") out[k] = countRel(model, row, v as Row);
      else if (REL[model]?.[k]) out[k] = related(model, row, k, v);
      else out[k] = row[k] === undefined ? null : row[k];
    }
    return out;
  }
  Object.assign(out, row);
  for (const [k, v] of Object.entries((args.include ?? {}) as Row)) {
    if (!v) continue;
    out[k] = k === "_count" ? countRel(model, row, v as Row) : related(model, row, k, v);
  }
  return out;
}

function removeRow(model: string, row: Row): void {
  mem.db[model] = mem.db[model].filter((r) => r !== row);
  for (const [child, fk] of CASCADE[model] ?? []) {
    for (const c of mem.db[child].filter((r) => r[fk] === row.id)) removeRow(child, c);
  }
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && "increment" in v) row[k] = Number(row[k] ?? 0) + Number(v.increment);
    else row[k] = v;
  }
  row.updatedAt = new Date();
}

const idOf = (row: Row): string => String(row.id ?? row.clientId ?? "?");

function modelApi(model: string): Row {
  return {
    async findUnique(args: Row) {
      const hit = mem.db[model].find((r) => matches(model, r, args.where));
      return hit ? shape(model, hit, args) : null;
    },
    async findFirst(args: Row = {}) {
      const rows = sortRows(mem.db[model].filter((r) => matches(model, r, args.where)), args.orderBy);
      return rows[0] ? shape(model, rows[0], args) : null;
    },
    async findMany(args: Row = {}) {
      let rows = sortRows(mem.db[model].filter((r) => matches(model, r, args.where)), args.orderBy);
      if (typeof args.take === "number") rows = rows.slice(0, args.take);
      return rows.map((r) => shape(model, r, args));
    },
    async count(args: Row = {}) {
      return mem.db[model].filter((r) => matches(model, r, args.where)).length;
    },
    async create(args: Row) {
      const row: Row = { id: `zz_gen_${++mem.seq}`, createdAt: new Date(), updatedAt: new Date(), ...args.data };
      emit(`write:${model}:${idOf(row)}`);
      mem.db[model].push(row);
      return shape(model, row, args);
    },
    async createMany(args: Row) {
      for (const d of args.data as Row[]) {
        const row: Row = { id: `zz_gen_${++mem.seq}`, createdAt: new Date(), updatedAt: new Date(), ...d };
        emit(`write:${model}:${idOf(row)}`);
        mem.db[model].push(row);
      }
      return { count: (args.data as Row[]).length };
    },
    async update(args: Row) {
      const hit = mem.db[model].find((r) => matches(model, r, args.where));
      if (!hit) throw new Error(`内存库：${model}.update 找不到行 ${JSON.stringify(args.where)}`);
      emit(`write:${model}:${idOf(hit)}`);
      applyData(hit, args.data);
      return shape(model, hit, args);
    },
    async upsert(args: Row) {
      const hit = mem.db[model].find((r) => matches(model, r, args.where));
      if (hit) {
        emit(`write:${model}:${idOf(hit)}`);
        applyData(hit, args.update);
        return shape(model, hit, args);
      }
      const row: Row = { createdAt: new Date(), updatedAt: new Date(), ...args.create };
      emit(`write:${model}:${idOf(row)}`);
      mem.db[model].push(row);
      return shape(model, row, args);
    },
    async delete(args: Row) {
      const hit = mem.db[model].find((r) => matches(model, r, args.where));
      if (!hit) throw new Error(`内存库：${model}.delete 找不到行`);
      emit(`delete:${model}:${idOf(hit)}`);
      removeRow(model, hit);
      return hit;
    },
    async groupBy(args: Row) {
      const by = (args.by as string[])[0];
      const groups = new Map<string, number>();
      for (const r of mem.db[model].filter((x) => matches(model, x, args.where))) {
        groups.set(r[by], (groups.get(r[by]) ?? 0) + Number(r.totalVolumeM3 ?? 0));
      }
      return [...groups.entries()].map(([k, sum]) => ({ [by]: k, _sum: { totalVolumeM3: { toNumber: () => sum } } }));
    },
  };
}

const sqlText = (strings: TemplateStringsArray): string => strings.join("?").replace(/\s+/g, " ").trim();
const find = (model: string, id: unknown): Row | undefined => mem.db[model].find((r) => r.id === id);

/** 只认路由里真出现的 SQL；认不出来抛错 */
async function raw(strings: TemplateStringsArray, ...values: any[]): Promise<any> {
  const sql = sqlText(strings);
  if (sql.includes("pg_advisory_xact_lock(83020")) {
    emit(`lock:client_price:${values[0]}`);
    return [];
  }
  if (sql.includes("pg_advisory_xact_lock(83001)")) {
    emit("lock:task_no");
    return [];
  }
  if (sql.includes("pg_advisory_xact_lock(83010)")) {
    emit("lock:plan_no");
    return [];
  }
  if (/SELECT MAX\(CAST\(SUBSTRING\(plan_no/.test(sql)) return [{ maxno: 0 }];
  if (/FROM whr_consolidation_prealerts pa JOIN/.test(sql)) {
    const pa = find("whrConsolidationPrealert", values[0]);
    const pc = pa && find("whrConsolidationPlanCustomer", pa.customerId);
    const plan = pc && find("whrConsolidationPlan", pc.planId);
    if (!plan) return [];
    emit(`lock:plan:${plan.id}`);
    return [{ status: plan.status }];
  }
  if (/FROM whr_consolidation_plans WHERE id = \? FOR UPDATE/.test(sql)) {
    emit(`lock:plan:${values[0]}`);
    const plan = find("whrConsolidationPlan", values[0]);
    return plan ? [{ id: plan.id, status: plan.status }] : [];
  }
  if (/FROM whr_consolidation_prealerts WHERE id = ANY\(\?\) FOR UPDATE/.test(sql)) {
    const ids = [...(values[0] as string[])].sort();
    for (const id of ids) emit(`lock:prealert:${id}`);
    return ids.map((id) => ({ id }));
  }
  if (/FROM whr_consolidation_prealerts WHERE id = \? FOR UPDATE/.test(sql)) {
    emit(`lock:prealert:${values[0]}`);
    return [{ id: values[0] }];
  }
  if (/^SELECT status FROM whr_consolidation_prealerts WHERE id = \?$/.test(sql)) {
    const pa = find("whrConsolidationPrealert", values[0]);
    return pa ? [{ status: pa.status }] : [];
  }
  if (/^SELECT id FROM users WHERE id = \? FOR UPDATE$/.test(sql)) {
    emit(`lock:user:${values[0]}`);
    const u = find("user", values[0]);
    return u ? [{ id: u.id }] : [];
  }
  if (/FROM agents WHERE id = \? AND company_id = \? FOR SHARE/.test(sql)) {
    emit(`lock:agent_share:${values[0]}`);
    const a = mem.db.agent.find((x) => x.id === values[0] && x.companyId === values[1]);
    return a
      ? [{ name: a.name, price_normal: a.priceNormal, price_inspection: a.priceInspection, price_sensitive: a.priceSensitive }]
      : [];
  }
  if (/FROM client_wallet_accounts/.test(sql) && /FOR UPDATE/.test(sql)) {
    emit(`lock:wallet:${values[0]}`);
    return [];
  }
  if (/FROM consolidation_tasks WHERE id = \? FOR UPDATE/.test(sql)) {
    emit(`lock:task:${values[0]}`);
    return [];
  }
  throw new Error(`内存库没实现这条 SQL：${sql}`);
}

export function installMemoryPrisma(): void {
  resetMemory();
  const stub: Row = {
    $queryRaw: raw,
    $executeRaw: raw,
    async $transaction(fn: unknown) {
      if (typeof fn !== "function") throw new Error("内存库只认回调式事务");
      return (fn as (tx: unknown) => Promise<unknown>)(stub);
    },
  };
  for (const m of MODELS) stub[m] = modelApi(m);
  (globalThis as any).__prisma = stub;
}

/* ─────────────────────────── 路由调用 ─────────────────────────── */

export const routes = new Map<string, Handler>();

/** 把模块里所有 register* 函数挂到假 app 上 */
export async function loadRoutes(modules: Row[]): Promise<void> {
  const fakeApp: Row = { listen() {} };
  for (const m of ["get", "post", "put", "patch", "delete"]) {
    fakeApp[m] = (p: string, h: Handler) => routes.set(`${m.toUpperCase()} ${p}`, h);
  }
  for (const mod of modules) {
    for (const [k, v] of Object.entries(mod)) {
      if (k.startsWith("register") && typeof v === "function") (v as (app: Row) => void)(fakeApp);
    }
  }
}

export interface CallResult {
  status: number;
  message: string;
  data: any;
  /** 过了一遍 JSON 的整个响应体 —— 跟浏览器收到的一样 */
  wire: any;
}

/**
 * 真调路由。BusinessError 照最外层的规矩翻成对应状态码（server.ts 做的事），别的错误原样抛出。
 */
export async function callRoute(
  key: string,
  auth: Row,
  input: { body?: Row; query?: Row } = {},
): Promise<CallResult> {
  const handler = routes.get(key);
  assert.ok(handler, `没注册到 ${key}`);
  const { isBusinessError } = await import("../apps/api/src/modules/core/business-error");
  let status = 200;
  let payload: any;
  const res: Row = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
    },
    setHeader() {},
    end() {},
  };
  const [method, path] = key.split(" ");
  try {
    await handler!({ method, path, query: input.query ?? {}, headers: {}, body: input.body ?? {}, auth }, res);
  } catch (e) {
    if (isBusinessError(e)) {
      status = e.httpStatus;
      payload = { code: e.code, message: e.message };
    } else {
      throw e;
    }
  }
  const wire = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
  return { status, message: wire?.message ?? "", data: wire?.data, wire };
}

/* ─────────────────────────── 断言小工具 ─────────────────────────── */

export const eventIndex = (event: string): number => mem.events.indexOf(event);

/** 断言 a 事件发生在 b 之前（两个都必须发生过） */
export function assertBefore(a: string, b: string, why: string): void {
  const ia = eventIndex(a);
  const ib = eventIndex(b);
  assert.ok(ia >= 0, `${why}：没发生「${a}」。事件：${mem.events.join(" → ")}`);
  assert.ok(ib >= 0, `${why}：没发生「${b}」。事件：${mem.events.join(" → ")}`);
  assert.ok(ia < ib, `${why}：「${a}」应该排在「${b}」前面。事件：${mem.events.join(" → ")}`);
}

export const writes = (): string[] => mem.events.filter((e) => e.startsWith("write:") || e.startsWith("delete:"));
