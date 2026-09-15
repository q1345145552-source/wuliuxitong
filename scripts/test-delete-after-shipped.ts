/**
 * 「已经发出去的柜谁都不能删，输管理员密码也不行」自测（2026-09-16，B1，确认单 4.15）。**不连数据库。**
 *
 * 仓库版 POST /admin/whr-consolidation/plans/delete、普通版 POST /admin/consolidation/tasks/delete：
 *   1. 红线本身（纯函数）：仓库版 计划 shipped/completed 或有预报单 shipped/thailand_received；
 *      普通版 任务 in_transit/customs/delivering/completed —— 而且用源码里真实的状态机核对「装柜之后的每一档都在红线里」
 *   2. 发运了：带着**正确的**管理员密码也 409，柜/任务还在，一把锁都没拿、一行都没删
 *   3. 预览（dryRun）回 hardBlocked=true，界面据此不给密码框
 *   4. 没发运：照原来的规矩（开始走流程要密码，密码对就能删；密码错 403）
 *   5. **事务外没发运、锁住那一刻刚发运** → 锁里重判照样 409（CLAUDE.md #28，带着正确密码）
 *   6. 两个页面的删除弹窗：hardBlocked 时不渲染密码框、不渲染确认按钮
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { callRoute, installMemoryPrisma, loadRoutes, mem, resetMemory, writes, type Row } from "./whr-memory-db";

installMemoryPrisma();

const failures: string[] = [];
let total = 0;
async function check(name: string, body: () => Promise<void> | void): Promise<void> {
  total += 1;
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").slice(0, 8).join("\n     ")}`);
  }
}

const ROOT = process.cwd();
const PASSWORD = "Admin#Pass2026";
const ADMIN = { userId: "zz_b1_admin", companyId: "c1", role: "admin", name: "老板本人", agentId: null };
const T0 = new Date("2026-09-01T01:00:00Z");
let ADMIN_HASH = "";

function seedWhr(planStatus: string, prealertStatus: string): void {
  resetMemory();
  mem.db.user.push({ id: ADMIN.userId, companyId: "c1", role: "admin", name: ADMIN.name, passwordHash: ADMIN_HASH, status: "active" });
  mem.db.whrConsolidationPlan.push({ id: "zz_b1_P", companyId: "c1", planNo: "WHR0009100", status: planStatus, createdAt: T0, updatedAt: T0 });
  mem.db.whrConsolidationPlanCustomer.push({ id: "zz_b1_pc", planId: "zz_b1_P", companyId: "c1", clientId: "zz_b1_c" });
  mem.db.whrConsolidationPrealert.push({ id: "zz_b1_pa", customerId: "zz_b1_pc", companyId: "c1", trackingNo: "WHRP9100", status: prealertStatus });
}

function seedTask(taskStatus: string): void {
  resetMemory();
  mem.db.user.push({ id: ADMIN.userId, companyId: "c1", role: "admin", name: ADMIN.name, passwordHash: ADMIN_HASH, status: "active" });
  mem.db.consolidationTask.push({ id: "zz_b1_T", companyId: "c1", taskNo: "JH0009100", clientId: "zz_b1_c", status: taskStatus, paymentStatus: "paid", createdAt: T0, updatedAt: T0 });
  mem.db.consolidationPrealert.push({ id: "zz_b1_cpa", taskId: "zz_b1_T", companyId: "c1", trackingNo: "JHP9100", status: "received" });
}

const planExists = (): boolean => mem.db.whrConsolidationPlan.some((p) => p.id === "zz_b1_P");
const taskExists = (): boolean => mem.db.consolidationTask.some((t) => t.id === "zz_b1_T");
const lockOrDelete = (): string[] => mem.events.filter((e) => e.startsWith("lock:") || e.startsWith("delete:") || e.startsWith("write:"));

async function main(): Promise<void> {
  const { hashPassword } = await import("../apps/api/src/modules/auth/crypto-utils");
  ADMIN_HASH = hashPassword(PASSWORD);
  const whr = await import("../apps/api/src/modules/whr-consolidation/routes");
  const cons = await import("../apps/api/src/modules/consolidation/routes");
  await loadRoutes([whr, cons]);

  console.log("发运后删柜红线");

  await check("1) 仓库版红线（纯函数）：计划已发运/已完成、或有预报单已发运/泰国签收 → 拦；装柜中、已付款不拦", () => {
    assert.equal(whr.whrPlanShippedReason("collecting", ["paid", "loading"]), null);
    assert.equal(whr.whrPlanShippedReason("loading", ["loading", "cancelled"]), null);
    for (const [plan, pas] of [["collecting", ["shipped"]], ["loading", ["paid", "thailand_received"]], ["completed", []], ["shipped", []], ["cancelled", ["shipped"]]] as Array<[string, string[]]>) {
      const reason = whr.whrPlanShippedReason(plan, pas);
      assert.ok(reason && reason.includes("输管理员密码也不行"), `${plan} / ${pas.join(",")} 没拦：${reason}`);
    }
  });

  await check("2) 普通版红线（纯函数）+ 用真实状态机核对：「装柜中」之后的每一档都在红线里，之前的都不在", () => {
    // 从源码里读 advance-status 的状态流转表，不自己抄一份（CLAUDE.md #25②）
    const src = fs.readFileSync(path.join(ROOT, "apps/api/src/modules/consolidation/routes.ts"), "utf-8");
    const block = /const validTransitions: Record<string, string> = \{([\s\S]*?)\};/.exec(src)?.[1];
    assert.ok(block, "源码里找不到 validTransitions —— 状态机挪位置了，这一项要跟着改");
    const next = new Map([...block!.matchAll(/(\w+):\s*"(\w+)"/g)].map((m) => [m[1], m[2]]));
    const afterLoading: string[] = [];
    for (let s = next.get("loading"); s; s = next.get(s)) afterLoading.push(s);
    assert.ok(afterLoading.length >= 3, `装柜之后只读到 ${afterLoading.join(",")}，正则可能读窄了`);
    for (const s of afterLoading) {
      assert.ok(cons.consolidationTaskShippedReason(s), `状态机里装柜之后的「${s}」不在红线里 —— 这一档的任务带密码就能删`);
    }
    for (const s of ["collecting", "full_confirmed", "quoted", "paid", "loading", "cancelled"]) {
      assert.equal(cons.consolidationTaskShippedReason(s), null, `还没发运的「${s}」被红线拦了`);
    }
  });

  await check("3) 仓库版：有预报单已发运 → 预览回 hardBlocked；带着正确密码删也 409，柜还在，一把锁都没拿", async () => {
    seedWhr("loading", "shipped");
    const preview = await callRoute("POST /admin/whr-consolidation/plans/delete", ADMIN, { body: { planId: "zz_b1_P", dryRun: true } });
    assert.equal(preview.status, 200, preview.message);
    assert.equal(preview.data.hardBlocked, true);
    assert.ok(String(preview.data.hardBlockReason).includes("输管理员密码也不行"));
    const r = await callRoute("POST /admin/whr-consolidation/plans/delete", ADMIN, { body: { planId: "zz_b1_P", confirmPassword: PASSWORD } });
    assert.equal(r.status, 409, `${r.status} ${r.message}`);
    assert.ok(planExists(), "带密码把已发运的柜删掉了");
    assert.deepEqual(lockOrDelete(), [], `被拦下还拿了锁 / 删了东西：${lockOrDelete().join(", ")}`);
  });

  await check("4) 仓库版：计划已完成（预报单全到泰国）→ 带密码也 409", async () => {
    seedWhr("completed", "thailand_received");
    const r = await callRoute("POST /admin/whr-consolidation/plans/delete", ADMIN, { body: { planId: "zz_b1_P", confirmPassword: PASSWORD } });
    assert.equal(r.status, 409);
    assert.ok(planExists());
  });

  await check("5) 仓库版：还没发运（已付款）照旧 —— 不带密码 409、密码错 403、密码对删掉", async () => {
    seedWhr("loading", "paid");
    const preview = await callRoute("POST /admin/whr-consolidation/plans/delete", ADMIN, { body: { planId: "zz_b1_P", dryRun: true } });
    assert.equal(preview.data.hardBlocked, false);
    assert.ok(preview.data.blockers.length > 0, "已付款的柜应该要密码");
    const noPwd = await callRoute("POST /admin/whr-consolidation/plans/delete", ADMIN, { body: { planId: "zz_b1_P" } });
    assert.equal(noPwd.status, 409);
    const wrong = await callRoute("POST /admin/whr-consolidation/plans/delete", ADMIN, { body: { planId: "zz_b1_P", confirmPassword: "wrong-password" } });
    assert.equal(wrong.status, 403);
    const r = await callRoute("POST /admin/whr-consolidation/plans/delete", ADMIN, { body: { planId: "zz_b1_P", confirmPassword: PASSWORD } });
    assert.equal(r.status, 200, r.message);
    assert.ok(!planExists(), "密码对、没发运，却没删掉");
  });

  await check("6) 仓库版：事务外还是「装柜中」、**锁住计划那一刻员工点了发运** → 带正确密码也 409，柜还在", async () => {
    seedWhr("loading", "loading");
    mem.onEvent = (e) => {
      if (e === "lock:plan:zz_b1_P") mem.db.whrConsolidationPrealert[0].status = "shipped";
    };
    const r = await callRoute("POST /admin/whr-consolidation/plans/delete", ADMIN, { body: { planId: "zz_b1_P", confirmPassword: PASSWORD } });
    assert.equal(r.status, 409, `锁里没重判发运：${r.status} ${r.message}`);
    assert.ok(planExists());
    assert.deepEqual(writes(), [], `被拦下还删了东西：${writes().join(", ")}`);
  });

  await check("7) 普通版：运输中 → 预览 hardBlocked；带正确密码也 409，任务还在，一把锁都没拿", async () => {
    seedTask("in_transit");
    const preview = await callRoute("POST /admin/consolidation/tasks/delete", ADMIN, { body: { taskId: "zz_b1_T", dryRun: true } });
    assert.equal(preview.status, 200, preview.message);
    assert.equal(preview.data.hardBlocked, true);
    const r = await callRoute("POST /admin/consolidation/tasks/delete", ADMIN, { body: { taskId: "zz_b1_T", confirmPassword: PASSWORD } });
    assert.equal(r.status, 409, `${r.status} ${r.message}`);
    assert.ok(taskExists());
    assert.deepEqual(lockOrDelete(), []);
  });

  await check("8) 普通版：装柜中（还没发运）→ 带正确密码照旧能删", async () => {
    seedTask("loading");
    const preview = await callRoute("POST /admin/consolidation/tasks/delete", ADMIN, { body: { taskId: "zz_b1_T", dryRun: true } });
    assert.equal(preview.data.hardBlocked, false);
    const r = await callRoute("POST /admin/consolidation/tasks/delete", ADMIN, { body: { taskId: "zz_b1_T", confirmPassword: PASSWORD } });
    assert.equal(r.status, 200, r.message);
    assert.ok(!taskExists());
  });

  await check("9) 普通版：事务外「装柜中」、**锁住任务那一刻推进到运输中** → 带正确密码也 409，任务还在", async () => {
    seedTask("loading");
    mem.onEvent = (e) => {
      if (e === "lock:task:zz_b1_T") mem.db.consolidationTask[0].status = "in_transit";
    };
    const r = await callRoute("POST /admin/consolidation/tasks/delete", ADMIN, { body: { taskId: "zz_b1_T", confirmPassword: PASSWORD } });
    assert.equal(r.status, 409, `锁里没重判发运：${r.status} ${r.message}`);
    assert.ok(taskExists());
  });

  await check("10) 两个删除弹窗：hardBlocked 时不给密码框、不给「确认删除」按钮", () => {
    const pages: Array<[string, string]> = [
      ["apps/web/src/app/admin/whr-consolidation/page.tsx", "deletePlanPreview"],
      ["apps/web/src/app/admin/consolidation/page.tsx", "deletePreview"],
    ];
    for (const [rel, v] of pages) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf-8");
      // 密码框只在「不是 hardBlocked」那一支里：hardBlocked 分支排在前面，密码框在它后面的 `: ${v} ? (` 分支里
      const hardIdx = text.indexOf(`{${v}?.hardBlocked ? (`);
      const elseIdx = text.indexOf(`) : ${v} ? (`, hardIdx);
      const pwdIdx = text.indexOf('placeholder="管理员密码"', elseIdx);
      assert.ok(hardIdx >= 0 && elseIdx > hardIdx && pwdIdx > elseIdx, `${rel}：密码框没有放在「不是 hardBlocked」那一支里`);
      assert.ok(text.includes(`{!${v}?.hardBlocked && (`), `${rel}：hardBlocked 时「确认删除」按钮还在`);
    }
    // 接口类型也要同步（CLAUDE.md #22）
    const api = fs.readFileSync(path.join(ROOT, "apps/web/src/services/business-api.ts"), "utf-8");
    assert.ok(/hardBlocked\?: boolean/.test(api), "business-api.ts 的删除预览类型没加 hardBlocked");
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/${total} 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log(`发运后删柜红线：${total} 项全部通过`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
