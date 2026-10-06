/**
 * 到货通知（2026-10-06）—— 不连库的测试：文案样子、菜单入口、「待入库」这个新状态在全系统的口径、几道闸还在。
 * 连库的那一份是 test:arrival-notices-db（真 handler + 真库，19 项）。
 *
 * 老板拍板见 schema.prisma 里 ArrivalNotice 那段注释；这里钉住的是：
 *   A1 给客户的文案：第一句唛头 + 仓库 + 件数，没登记的那一行不出现，内部备注不进文案
 *   A2 员工、超管菜单「运单」组第一项「到货通知」，顶栏标题登记了
 *   A3 「待入库」算「未发出」、不算在途、不在两条流程表里（柜子推进推不动它）、中文 / 筛选 / AI 名单都有
 *   A4 几道闸：装柜接口挡、装柜页勾不上、运单管理两条改单路挡、两处「未发出」引用共享名单
 *   A5 页面接口网址都比页面多一段（GET /staff/arrival-notices 会被页面接走）
 *   A6 页面「还缺什么」跟后端同一张单子、同一个顺序
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✅ ${name}`);
}

async function main(): Promise<void> {
  const { buildArrivalNoticeText } = await import("../apps/web/src/modules/arrival-notice/notice-text");
  const { missingForFormal } = await import("../apps/web/src/modules/arrival-notice/missing");
  const shared = await import("../packages/shared-types/shipment-status");
  const { SHIPMENT_STATUS_ZH, SHIPMENT_STATUS_FILTER_OPTIONS, shipmentStatusZh } = await import("../apps/web/src/modules/shipment/shipment-status");
  const { roleFunctionGroups } = await import("../apps/web/src/modules/layout/menu-config");

  await check("A1 文案：齐的时候一字不差；没登记的行不出现；没唛头 / 没仓库 / 没件数有兜底说法；备注不进文案", () => {
    const full = {
      clientId: "ABC-001", warehouseId: "wh_yiwu_01", packageCount: 12, itemName: "灯具",
      weightKg: 85, volumeM3: 0.62, domesticTrackingNo: "SF1234567890", arrivedAt: "2026-10-06",
    };
    assert.equal(buildArrivalNoticeText(full), [
      "您好！唛头 ABC-001 的货已到义乌仓，共 12 件。",
      "品名：灯具",
      "重量：85 公斤　体积：0.62 立方",
      "国内快递单号：SF1234567890",
      "到仓日期：10月6日",
      "如需安排发货或有疑问，请随时联系我们，谢谢！",
    ].join("\n"), "跟发给老板看的那一版不一样了");
    const bare = { clientId: null, warehouseId: null, packageCount: null, itemName: null, weightKg: null, volumeM3: null, domesticTrackingNo: null, arrivedAt: null };
    assert.equal(buildArrivalNoticeText(bare), "您好！您的货已到仓。\n如需安排发货或有疑问，请随时联系我们，谢谢！");
    const onlyVolume = buildArrivalNoticeText({ ...bare, clientId: "XPP-0015 XHH-6698", warehouseId: "wh_shenzhen_01", volumeM3: 1.5 });
    assert.equal(onlyVolume.split("\n")[0], "您好！唛头 XPP-0015 XHH-6698 的货已到深圳仓。", "带空格的唛头原样写");
    assert.equal(onlyVolume.split("\n")[1], "体积：1.5 立方", "只有体积时只写体积");
    const withRemark = buildArrivalNoticeText({ ...full, remark: "内部：外箱破了" } as never);
    assert.ok(!withRemark.includes("外箱破了"), "内部备注不许进给客户的文案");
  });

  await check("A2 菜单：员工、超管「运单」组第一项都是「到货通知」→ /staff/arrival-notices；顶栏标题登记了", () => {
    for (const role of ["staff", "admin"] as const) {
      const group = roleFunctionGroups[role].find((g) => g.groupLabel === "运单");
      assert.ok(group, `${role} 没有「运单」组`);
      assert.equal(group!.items[0].label, "到货通知");
      assert.equal(group!.items[0].href, "/staff/arrival-notices");
    }
    for (const role of ["client", "agent"] as const) {
      const all = JSON.stringify(roleFunctionGroups[role]);
      assert.ok(!all.includes("arrival-notices"), `${role} 菜单里不许有到货通知`);
    }
    assert.match(read("apps/web/src/modules/layout/WorkbenchFrame.tsx"), /"\/staff\/arrival-notices": "到货通知"/);
  });

  await check("A3 「待入库」：算未发出、不算在途、不进流程表；中文、筛选、AI 名单、轨迹颜色都有", () => {
    assert.ok(shared.PENDING_STATUSES.includes("pendingInbound"));
    assert.equal(shared.classifyStatusGroup("pendingInbound"), "pending");
    assert.equal(shared.isInTransitStatus("pendingInbound"), false);
    assert.ok(!shared.IN_TRANSIT_STATUSES.includes("pendingInbound" as never));
    assert.ok(!shared.SHIPMENT_STATUS_FLOW.includes("pendingInbound"), "进了流程表柜子推进就能把它推走");
    assert.ok(!shared.SHIPMENT_STATUS_FLOW_LAND.includes("pendingInbound"));
    const backendFlow = read("apps/api/src/modules/shipments/status-flow.ts");
    assert.ok(!backendFlow.includes("pendingInbound"), "后端流程表也不许有");
    assert.equal(SHIPMENT_STATUS_ZH.pendinginbound, "待入库");
    assert.equal(shipmentStatusZh("pendingInbound"), "待入库");
    assert.ok(SHIPMENT_STATUS_FILTER_OPTIONS.includes("待入库"), "状态筛选下拉要能选到（客户也看得到这个状态）");
    assert.match(read("apps/api/src/modules/ai/ai-config-store.ts"), /\{ status: "pendingInbound", labelZh: "待入库" \}/);
    assert.match(read("apps/web/src/modules/shipment/ShipmentTrackModal.tsx"), /pendinginbound: \{ zh: "待入库"/);
  });

  await check("A4 几道闸都在：装柜接口 / 装柜页 / 运单管理两条改单路；两处「未发出」引用共享名单", () => {
    assert.match(read("apps/api/src/modules/loading-manifests/routes.ts"), /if \(locked\.currentStatus === "pendingInbound"\) \{\s*throw new Error\(/);
    const cl = read("apps/web/src/app/staff/container-loading/page.tsx");
    assert.match(cl, /const pendingInbound = s\.currentStatus === "pendingInbound";/);
    assert.match(cl, /disabled=\{alreadyIn \|\| pendingInbound \|\|/);
    const admin = read("apps/api/src/modules/admin/routes.ts");
    assert.match(admin, /currentStatus: PENDING_INBOUND \}[\s\S]{0,200}PENDING_INBOUND_EDIT_ELSEWHERE_MESSAGE/);
    const orders = read("apps/api/src/modules/orders/routes.ts");
    assert.match(orders, /if \(shipment\.currentStatus === PENDING_INBOUND\) \{\s*fail\(res, 400, "BAD_REQUEST", PENDING_INBOUND_EDIT_ELSEWHERE_MESSAGE\);/);
    const counts = read("apps/api/src/modules/shipments/overview-counts.ts");
    assert.match(counts, /currentStatus: \{ in: \[\.\.\.PENDING_STATUSES\] \}/);
    assert.ok(!/\["created", "inWarehouseCN", "holdLoading"\]/.test(counts), "又手写回三个了");
    assert.match(read("apps/web/src/app/admin/page.tsx"), /const notShipped = new Set<string>\(\["", \.\.\.PENDING_STATUSES\]\);/);
  });

  await check("A5 接口网址都比页面多一段：前端、后端都没有裸的 /staff/arrival-notices", () => {
    const api = read("apps/web/src/services/arrival-notice-api.ts");
    const front = [...api.matchAll(/["`}]\/staff\/arrival-notices([^"`?]*)/g)].map((m) => m[1]);
    assert.ok(front.length >= 7, `前端接口太少：${front.join(",")}`);
    assert.ok(front.every((rest) => rest.startsWith("/")), `有裸网址：${front.join(",")}`);
    const routes = read("apps/api/src/modules/arrival-notices/routes.ts");
    const back = [...routes.matchAll(/app\.(get|post|delete|put)\("([^"]+)"/g)].map((m) => m[2]);
    assert.equal(back.length, 7);
    assert.ok(back.every((p) => p.startsWith("/staff/arrival-notices/")), back.join(","));
    for (const p of back) assert.ok(api.includes(p), `前端没调 ${p}`);
    assert.match(routes, /requireRole\(req, res, \["staff", "admin"\]\)/);
    assert.equal((routes.match(/requireRole\(req, res, \["staff", "admin"\]\)/g) ?? []).length, 7, "每个接口都只给员工 / 超管");
  });

  await check("A6 页面「还缺什么」跟后端 missingForTarget 同一张单子、同一个顺序", async () => {
    const { missingForTarget } = await import("../apps/api/src/modules/arrival-notices/routes");
    const full = { clientId: "A", trackingNo: "T", itemName: "I", packageCount: 1, weightKg: 1, volumeM3: 1, transportMode: "sea" as const, domesticTrackingNo: null, warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-06", remark: null };
    const keys = ["clientId", "trackingNo", "itemName", "packageCount", "weightKg", "volumeM3", "transportMode", "warehouseId", "arrivedAt"] as const;
    const cases = [full, ...keys.map((k) => ({ ...full, [k]: null })), Object.fromEntries(Object.entries(full).map(([k, v]) => [k, k === "remark" || k === "domesticTrackingNo" ? v : null])) as typeof full];
    for (const c of cases) {
      assert.deepEqual(missingForFormal(c), missingForTarget(c, "formal"), JSON.stringify(c));
    }
    assert.deepEqual(missingForTarget({ ...full, clientId: null, trackingNo: null, itemName: null }, "inbound"), ["运单号", "唛头"], "转待入库只要运单号 + 唛头");
  });

  await check("A7 保存回给页面的那一行在锁里读（页面拿它当下次的 base）；列表在同一个快照里查", () => {
    const routes = read("apps/api/src/modules/arrival-notices/routes.ts");
    const saveStart = routes.indexOf('app.post("/staff/arrival-notices/save"');
    const saveEnd = routes.indexOf("app.post(", saveStart + 10);
    assert.ok(saveStart > 0 && saveEnd > saveStart, "找不到保存接口了");
    const save = routes.slice(saveStart, saveEnd);
    /* 2026-10-06 Codex 第二轮 M3：原来事务提交以后再 loadDto 去库里读，提交和读之间同事又存了一次，
       页面就把同事那份当成 base，下次保存比对通过、把同事的盖掉。所以保存接口里不许再出现事务外的 loadDto */
    assert.ok(!save.includes("loadDto("), "保存接口里不许用 loadDto（事务提交后再读），要回事务里读的那份");
    assert.match(save, /saved = await prisma\.\$transaction/, "修改那条路要把事务里读的那份带出来");
    assert.match(save, /return toDto\(row,/, "事务里用刚 update 出来的那行出 DTO");
    assert.match(save, /ok\(res, \{ item: saved \}\)/);
    assert.match(save, /ok\(res, \{ item: toDto\(created, null, auth\.role\) \}\)/, "新登记回的就是刚插进去的那一行");
    // 页面：存上以后 base 换成回来的那份
    const view = read("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx");
    assert.match(view, /saveArrivalNotice\(id, draft, base\)/);
    assert.match(view, /setBase\(draftOf\(item\)\)/);
    // Codex 第二轮 S1：列表的 gone / 数页签 / 拉这一页 / 查运单状态在同一个「可重复读」快照里
    const listStart = routes.indexOf('app.get("/staff/arrival-notices/list"');
    const list = routes.slice(listStart, routes.indexOf("app.post(", listStart));
    assert.match(list, /isolationLevel: Prisma\.TransactionIsolationLevel\.RepeatableRead/, "列表要在同一个快照里查");
    assert.ok(!/\bprisma\.(arrivalNotice|shipment|\$queryRaw)/.test(list), "列表里的查询都要走快照事务 tx，不许夹着直接用 prisma 的");
  });

  console.log(`\n到货通知（不连库）${passed} 项全部通过`);
  // 后端 routes 一 import 就带上了 prisma，不连库也会挂着句柄，直接退出
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
