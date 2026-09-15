/**
 * 员工改客户派送地址的自测（2026-08-29 加，老板要求「尾端这要加个编辑」）。
 *
 * ⚠️ 全程**不连数据库**：apps/api/src/db/prisma.ts 是
 * `globalThis.__prisma ?? new PrismaClient()`，所以在 import 之前把 __prisma
 * 换成假的，PrismaClient 根本不会被 new 出来。下面那行被挡死的 DATABASE_URL
 * 是第二道保险 —— 万一哪天这条路上多了一次真库调用，会当场炸出来。
 *
 * ⚠️ 为什么不扫源码：扫源码只能证明「这几个字出现过」，证明不了路由真的这么干
 * （test-product-rows.ts 第 11 项记的就是这个教训）。这里真注册路由、真调 handler。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

type Handler = (req: any, res: any) => Promise<void> | void;

const failures: string[] = [];
async function check(name: string, body: () => Promise<void>): Promise<void> {
  try { await body(); console.log(`  ✅ ${name}`); }
  catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

/** 假库：findFirst 返回什么由 existing 控制；update 把参数录下来供断言 */
let existing: unknown = null;
let updateCalls: any[] = [];
let findFirstArgs: any[] = [];
(globalThis as any).__prisma = {
  clientAddress: {
    async findFirst(args: unknown) { findFirstArgs.push(args); return existing; },
    async update(args: unknown) { updateCalls.push(args); return { id: "addr_1" }; },
  },
};

async function main(): Promise<void> {
  const routes = new Map<string, Handler>();
  const fakeApp: any = {
    get(p: string, h: Handler) { routes.set(`GET ${p}`, h); },
    post(p: string, h: Handler) { routes.set(`POST ${p}`, h); },
    delete(p: string, h: Handler) { routes.set(`DELETE ${p}`, h); },
    listen() {},
  };
  const mod = await import("../apps/api/src/modules/client-compliance/routes");
  (mod as any).registerClientComplianceRoutes(fakeApp);

  const handler = routes.get("POST /staff/client-addresses/update");
  assert.ok(handler, "没注册到 POST /staff/client-addresses/update");

  async function call(body: unknown, role = "staff"): Promise<{ status: number; message: string }> {
    let status = 0;
    let payload: { message?: string } = {};
    const res: any = { status(c: number) { status = c; return res; }, json(v: unknown) { payload = v as { message?: string }; } };
    await handler!({
      method: "POST", path: "", query: {}, headers: {}, body,
      auth: { userId: "STAFF1", companyId: "c_001", role, name: "测试员工", agentId: null },
    }, res);
    return { status, message: payload.message ?? "" };
  }

  const GOOD = { id: "addr_1", contactName: "高彬彬", contactPhone: "092-4073488", addressDetail: "209/24 หมู่ 2" };

  console.log("员工改客户派送地址");

  await check("1) 缺 id / 缺必填项一律 400，而且是中文", async () => {
    existing = { id: "addr_1" };
    for (const [bad, want] of [
      [{ ...GOOD, id: "" }, "缺少地址 id"],
      [{ ...GOOD, contactName: "  " }, "联系人姓名为必填"],
      [{ ...GOOD, contactPhone: "" }, "联系电话为必填"],
      [{ ...GOOD, addressDetail: "" }, "详细地址为必填"],
    ] as [any, string][]) {
      const r = await call(bad);
      assert.equal(r.status, 400, `${want}：应该 400，实际 ${r.status}`);
      assert.equal(r.message, want, `提示语不对：${JSON.stringify(r.message)}`);
    }
  });

  await check("2) 别家公司的地址改不动 —— 必须 404，而且没发生任何写入", async () => {
    /**
     * ⚠️ 这一条是照 CLAUDE.md 第 27 条的教训写的：
     * 「加了过滤条件，必须同时加『查不到就 return』」——
     * 只加 where 不判空，后面照样会拿着 null 往下跑。
     */
    existing = null;              // 按 companyId 查不到
    updateCalls = [];
    const r = await call(GOOD);
    assert.equal(r.status, 404, `应该 404，实际 ${r.status}`);
    assert.ok(r.message.includes("找不到"), `提示语不对：${JSON.stringify(r.message)}`);
    assert.equal(updateCalls.length, 0, "查不到还是去写库了 —— 等于公司隔离形同虚设");
  });

  await check("3) 查这条地址时必须带上 companyId", async () => {
    existing = { id: "addr_1" };
    findFirstArgs = [];
    await call(GOOD);
    const where = findFirstArgs[0]?.where ?? {};
    assert.equal(where.id, "addr_1");
    assert.equal(where.companyId, "c_001", `查地址没带公司过滤：${JSON.stringify(where)}`);
  });

  await check("4) 正常改：三个字段都写进去，而且都 trim 过", async () => {
    existing = { id: "addr_1" };
    updateCalls = [];
    const r = await call({ id: " addr_1 ", contactName: " 高彬彬 ", contactPhone: " 092-4073488 ", addressDetail: " 209/24 หมู่ 2 " });
    assert.equal(r.status, 200, `成功应该是 200，实际 ${r.status}`);
    assert.equal(updateCalls.length, 1, "没写库");
    assert.deepEqual(updateCalls[0].where, { id: "addr_1" });
    assert.equal(updateCalls[0].data.contactName, "高彬彬");
    assert.equal(updateCalls[0].data.contactPhone, "092-4073488");
    assert.equal(updateCalls[0].data.addressDetail, "209/24 หมู่ 2");
  });

  await check("5) 没传 label 就不许动它 —— 别把客户已有的地址名清掉", async () => {
    /**
     * 前端那个编辑框里没有 label 这一项。要是无脑写 `label: body.label ?? null`，
     * 员工改一次电话，客户自己起的地址名（「公司」「家」）就没了。
     */
    existing = { id: "addr_1" };
    updateCalls = [];
    await call(GOOD);
    assert.ok(!("label" in updateCalls[0].data), `没传 label 却动了它：${JSON.stringify(updateCalls[0].data)}`);

    updateCalls = [];
    await call({ ...GOOD, label: " 公司 " });
    assert.equal(updateCalls[0].data.label, "公司", "传了 label 反而没写进去");

    updateCalls = [];
    await call({ ...GOOD, label: "   " });
    assert.equal(updateCalls[0].data.label, null, "传了空白 label 应该清成 null");
  });

  await check("6) 客户角色不许改别人的地址", async () => {
    existing = { id: "addr_1" };
    updateCalls = [];
    const r = await call(GOOD, "client");
    assert.notEqual(r.status, 200, `客户角色居然放行了（${r.status}）`);
    assert.equal(updateCalls.length, 0, "客户角色写库了");
  });

  delete (globalThis as any).__prisma;
  if (failures.length > 0) {
    console.log(`\n${failures.length} 项不通过：${failures.join(" / ")}`);
    process.exit(1);
  }
  console.log(`员工改客户派送地址：6 项全部通过`);
}

main().catch((e) => { console.error(e); process.exit(1); });
