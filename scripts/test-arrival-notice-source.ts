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
 *   A7 保存回给页面的那一行在锁里读；列表在同一个快照里查
 *   A8 超管端运单详情：待入库的单产品图只能看
 *   A9–A17 2026-10-08 审查 19 条里「到货通知页面」那几条（F01 / F02 / F05 / F06 / F11 / F12 / F14 / F15 / G01 / G03）
 *   A18 修复审查：G01 那句「改回未通知」在照片没传完那两条路上不许丢
 *   A14b / A19 修复第 1 轮：选照片 HEIC / 认不出的不悄悄丢；「正在处理」按 id 各管各的
 *   A20 / A21 修复第 2 轮：保存中整张表锁住；选照片 / 上传接口只收电脑上显示得了的格式（同一份白名单）
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
    const full = { clientId: "A", trackingNo: "T", itemName: "I", packageCount: 1, weightKg: 1, volumeM3: 1, transportMode: "sea" as const, domesticTrackingNo: null, warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-06", cargoType: null, remark: null };
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
    // 2026-10-08 F01：新登记回包要带上撞上的预报单（create 之前查好的 newMatches）
    assert.match(save, /ok\(res, \{ item: toDto\(created, null, auth\.role, newMatches\) \}\)/, "新登记回的就是刚插进去的那一行");
    /* Codex 第三轮建议 2：光禁 loadDto 这个名字不够 —— 事务结束后换个写法再 prisma.arrivalNotice.findFirst 一次、
       再 saved = toDto(那份) 照样把竞态带回来。所以：修改那条路事务结束以后、新登记 create 之后，都不许再碰数据库；saved 只许赋值一次 */
    const txEnd = save.indexOf("}, { timeout: 30000, maxWait: 10000 });");
    assert.ok(txEnd > 0, "找不到修改那条路的事务结尾了");
    assert.ok(!/\bprisma\./.test(save.slice(txEnd)), "保存事务结束以后不许再查库（回给页面的必须是事务里那份）");
    assert.equal((save.match(/\bsaved\s*=/g) ?? []).length, 1, "saved 只许由事务赋值那一次");
    const cStart = save.indexOf("created = await prisma");
    const cEnd = save.indexOf("ok(res, { item: toDto(created", cStart);
    assert.ok(cStart > 0 && cEnd > cStart, "找不到新登记那条路了");
    assert.ok(!/\bprisma\./.test(save.slice(cStart + "created = await prisma".length, cEnd)), "新登记 create 之后、回给页面之前不许再查库");
    assert.equal((save.match(/\bcreated\s*=/g) ?? []).length, 1, "created 只许由 create 赋值那一次");
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

  await check("A8 超管端运单详情：待入库的单产品图只能看（没有删除叉、没有上传框）、有提示；删图失败有提示", () => {
    // 2026-10-06 第二轮（dsh A / Codex S3）：员工端改成只读了，超管端漏了；后端两道闸挡着，这里钉住页面
    const admin = read("apps/web/src/app/admin/page.tsx");
    const start = admin.indexOf("<AdminShipmentDetail");
    const panel = admin.slice(start, admin.indexOf("</DetailModal>", start));
    assert.ok(start > 0 && panel.length > 0, "找不到超管端运单详情的产品图那一块了");
    assert.equal((panel.match(/o\.currentStatus === "pendingInbound"/g) ?? []).length, 3, "删除叉、有图时的上传框、没图时的上传框三处都要看待入库");
    assert.match(panel, /\{o\.currentStatus === "pendingInbound" \? null : <button[^>]*onClick=\{async \(\) => \{ try \{ await deleteStaffOrderProductImage/, "待入库不给删除叉；删图要 try");
    assert.match(panel, /catch \(err\) \{ setMessage\("删除失败：/, "删图失败要有提示（原来没接，点了没反应）");
    assert.equal((panel.match(/这票货还是「待入库」，照片请到「到货通知」里传/g) ?? []).length, 2, "有图 / 没图两种都给提示");
    assert.equal((panel.match(/type="file"/g) ?? []).length, 2, "上传框还是两个（只是待入库时换成提示）");
  });

  // ───── 2026-10-08 审查 19 条里「到货通知页面」那几条 ─────
  const view = () => read("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx");
  const sliceBetween = (src: string, start: string, end: string) => {
    const a = src.indexOf(start);
    assert.ok(a >= 0, `找不到「${start}」`);
    const b = src.indexOf(end, a + start.length);
    assert.ok(b > a, `找不到「${end}」`);
    return src.slice(a, b);
  };
  /** 把 fetch 换成假的，记下页面发给后端的请求体（不连任何服务器） */
  const captureBodies = async (work: () => Promise<unknown>) => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
      bodies.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ code: "OK", data: { item: {} } }), { status: 200 });
    }) as typeof fetch;
    try { await work(); } finally { (globalThis as { fetch: typeof fetch }).fetch = realFetch; }
    return bodies;
  };

  await check("A9 F05/F14 传照片：关了就停；满 20 张就停、不去撞后端；上限跟后端同一个数", async () => {
    const pu = await import("../apps/web/src/modules/arrival-notice/photo-upload");
    const { MAX_NOTICE_IMAGES } = await import("../apps/api/src/modules/arrival-notices/routes");
    assert.equal(pu.MAX_NOTICE_IMAGES, MAX_NOTICE_IMAGES, "前端照片上限要跟后端 routes.ts 一样");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // 关弹窗：传到一半叫停，后面的不再发
    let cancelled = false;
    const sent: number[] = [];
    const run = pu.uploadQueuedPhotos({
      items: [1, 2, 3, 4, 5, 6, 7, 8], existingCount: 0, isCancelled: () => cancelled,
      upload: async (n) => { sent.push(n); await sleep(15); return { count: sent.length }; },
    });
    await sleep(35); cancelled = true;
    const r1 = await run;
    assert.equal(r1.cancelled, true);
    assert.ok(sent.length <= 3, `关了还在传：${sent.join(",")}`);
    // 压缩完发现关了：这张不发
    const r2 = await pu.uploadQueuedPhotos({ items: [1, 2], existingCount: 0, isCancelled: () => false, upload: async () => "cancelled" as const });
    assert.equal(r2.cancelled, true); assert.equal(r2.uploaded, 0);
    // 已有 18 张，再传 5 张：传 2 张就停，剩 3 张算没传、标「满了」
    const sent3: number[] = [];
    let c = 18;
    const r3 = await pu.uploadQueuedPhotos({ items: [1, 2, 3, 4, 5], existingCount: 18, isCancelled: () => false, upload: async (n) => { sent3.push(n); c += 1; return { count: c }; } });
    assert.deepEqual(sent3, [1, 2]);
    assert.equal(r3.limitReached, true); assert.equal(r3.failed, 3);
    // 普通失败照旧记第一条原因、接着传
    const r4 = await pu.uploadQueuedPhotos({ items: [1, 2, 3], existingCount: 0, isCancelled: () => false, upload: async (n) => { if (n === 2) throw new Error("网断了"); return { count: n }; } });
    assert.equal(r4.failed, 1); assert.equal(r4.firstError, "网断了"); assert.equal(r4.uploaded, 2); assert.equal(r4.limitReached, false);
    assert.equal(pu.photoSlotsLeft(18, 0), 2); assert.equal(pu.photoSlotsLeft(15, 9), 0); assert.equal(pu.photoSlotsLeft(0, 0), 20);
  });

  await check("A10 F05 页面：弹窗按 seq 只关自己；卸载就叫停（StrictMode 装回来复位）；保存中关窗不再说「关掉就没了」；传照片用 uploadQueuedPhotos", () => {
    const v = view();
    assert.match(v, /setEditor\(\(cur\) => \(cur && cur\.seq === seq \? null : cur\)\)/, "关弹窗要核 seq，不能无条件 setEditor(null)");
    assert.ok(!/setEditor\(null\)/.test(v), "不许再无条件 setEditor(null)（晚到的回调会关掉后开的弹窗）");
    assert.match(v, /<NoticeEditor\s+(?:\/\/[^\n]*\n\s*)*key=\{`editor-\$\{editor\.seq\}`\}/, "每开一次弹窗换一个实例（key 带 editor- 前缀）");
    // 同一层还有 <Toast key={toast.seq}>：弹窗 key 若也是光秃秃的数字，两个计数都到 7 时撞 key，
    // React 认错元素，存完 / 点 ✕ 弹窗关不掉、卡在「保存中…」（10-08 浏览器实点抓到）
    assert.ok(!/<NoticeEditor\s+(?:\/\/[^\n]*\n\s*)*key=\{editor\.seq\}/.test(v), "弹窗 key 不许是光秃秃的 editor.seq（会和 Toast 的 key 撞）");
    assert.match(v, /<Toast key=\{toast\.seq\}/, "Toast 的 key 变了，上面防撞的判断要跟着看");
    assert.match(v, /onSaved=\{\(message\) => \{ closeEditor\(editor\.seq\);/);
    assert.match(v, /onClose=\{\(\) => closeEditor\(editor\.seq\)\}/);
    // R1：开发模式 StrictMode 会先卸再装，ref 不复位的话 next dev 下照片永远不传、卡在「保存中」
    assert.match(v, /cancelledRef\.current = false;[\s\S]{0,200}return \(\) => \{\s*cancelledRef\.current = true;/, "弹窗卸载要叫停后台上传，装上时要复位");
    assert.ok(v.includes("cancelledRef.current = false"), "挂载时要把 cancelledRef 复位");
    assert.match(v, /if \(cancelledRef\.current\) \{ void props\.onChanged\(\); return; \}/, "保存回来发现弹窗已关：只刷新列表，不回调 onSaved");
    assert.match(v, /uploadQueuedPhotos\(\{/);
    assert.ok(!/for \(let i = 0; i < todo\.length; i\+\+\)/.test(v), "老的逐张上传循环（不看弹窗关没关）还在");
    const cc = sliceBetween(v, "const confirmClose = () => {", "\n  };");
    assert.match(cc, /if \(saving\) \{/, "保存中关窗要单独问");
    const savingBranch = sliceBetween(cc, "if (saving) {", "return ok;");
    assert.ok(!savingBranch.includes("关掉就没了"), "保存中关掉照片其实还在传，不能说「关掉就没了」");
    assert.match(savingBranch, /cancelledRef\.current = true/);
    assert.match(v, /className="an-photo-add" disabled=\{saving\}/, "传照片途中不许再加（加了不会传、传完弹窗一关就丢）");
  });

  await check("A11 F12：操作完的刷新用现在的页签（loadRef），不用点按钮那一刻的 load", () => {
    const v = view();
    // 只剩实时推送那一处（useLiveRefresh 每次渲染拿最新的 refresh，本来就是现在的页签）
    assert.deepEqual([...v.matchAll(/^.*await load\(true\).*$/gm)].map((m) => m[0].trim()), ["refresh: async (isStillWanted) => { if (isStillWanted()) await load(true); },"], "操作回调里不许 await load(true)（那是点按钮那一刻的旧页签）");
    assert.ok(!/void load\(true\)/.test(v), "弹窗回调里不许 void load(true)");
    assert.ok(!/\(\) => load\(true\)/.test(v), "弹窗 onChanged 不许再绑点开那一刻的 load");
    assert.match(v, /useLayoutEffect\(\(\) => \{ loadRef\.current = load; \}, \[load\]\);/);
    assert.match(v, /const reloadLatest = useCallback\(\(\) => loadRef\.current\(true\), \[\]\);/);
    assert.equal((v.match(/await reloadLatest\(\)/g) ?? []).length, 3, "标已通知 / 转运单 / 删除 三处");
    assert.match(v, /onChanged=\{reloadLatest\}/);
    assert.match(v, /if \(gate\.current\.isCurrent\(ticket\)\) setLoading\(false\);/, "最新那次（悄悄的也算）要收掉加载态");
    assert.match(v, /if \(!silent \|\| shownKeyRef\.current !== key\) setLoadError/, "手上列的是别的页签时，悄悄重拉失败也要报");
  });

  await check("A12 F15：唛头下拉不截断（跟「创建订单」一样全列）", () => {
    const dl = sliceBetween(view(), '<datalist id="an-client-options">', "</datalist>");
    assert.ok(!/\.slice\(/.test(dl), "唛头下拉又被截断了");
    assert.match(dl, /clientOptions\.map/);
    const memo = sliceBetween(view(), "const clientOptions = useMemo(", "}, [props.clients, draft.clientId]);");
    assert.ok(!/\.slice\(/.test(memo), "筛选那段也不许截断");
  });

  await check("A13 G03：卡片和修改弹窗里的小方块用小图、滚到了才下；大图 / 复制 / 保存仍用原图", () => {
    const v = view();
    const imgs = [...v.matchAll(/<img src=\{thumbSrc\(img\)\}[^>]*>/g)].map((m) => m[0]);
    assert.equal(imgs.length, 2, "卡片一处、修改弹窗一处");
    for (const tag of imgs) { assert.match(tag, /loading="lazy"/, tag); assert.match(tag, /decoding="async"/, tag); }
    assert.ok(!/<img src=\{imgSrc\(img\)\}/.test(v), "小方块不许再直接用原图");
    assert.match(v, /return apiBaseUrl\(\) \+ \(img\.thumbUrl \?\? img\.imageUrl\);/, "没有小图（老照片 / 老后端）退回原图");
    assert.match(v, /setPreview\(\{ src: imgSrc\(img\)/, "点开大图用原图");
    assert.match(v, /copyImage\(imgSrc\(img\)\)/, "复制用原图");
    assert.match(v, /saveImage\(imgSrc\(img\), img\.fileName\)/, "保存用原图");
  });

  await check("A14 F14 页面：选照片时按上限截、说清哪几张没加；满了不给「加照片」；满了的提示不说「再点保存接着传」", async () => {
    const v = view();
    const add = sliceBetween(v, "const addFiles = ", "\n  };");
    assert.match(add, /photoSlotsLeft\(/);
    // 修复第 1 轮：规则挪进 pickPhotos（HEIC / 认不出的 / 超上限都要说出来），页面只用它的结果
    assert.match(add, /const \{ take, note \} = pickPhotos\(Array\.from\(files\), photoSlotsLeft\(images\.length, queuedRef\.current\.length\)\);\s*setPickNote\(note\);/, "选照片要走 pickPhotos");
    assert.ok(!/\.filter\(\(f\) => f\.type\.startsWith\("image\/"\)\)/.test(add), "页面里不许再自己悄悄滤掉非图片");
    assert.match(v, /\{pickNote \? <p className="an-warn">\{pickNote\}<\/p> : null\}/, "没加的那几张要显示出来");
    assert.match(v, /已满 \{MAX_NOTICE_IMAGES\} 张/);
    const limit = sliceBetween(v, "if (r.limitReached) {", "return;");
    assert.ok(!limit.includes("接着传"), "满了再点保存也传不上，不能叫人再点");
    // 提示文字挪进了 photoFailMessage（A18），这里真跑一遍满了那条路
    const { photoFailMessage } = await import("../apps/web/src/modules/arrival-notice/photo-upload");
    assert.ok(!photoFailMessage({ limitReached: true, failed: 3, firstError: null }, "").includes("接着传"), "满了再点保存也传不上，不能叫人再点");
  });

  await check("A14b 修复第 1 轮 选照片：HEIC 不加、说清原因；type 为空 / 不是图片的不悄悄丢；「这次选了」按真选的个数；超上限照旧列出来", async () => {
    const { pickPhotos, isHeicFile } = await import("../apps/web/src/modules/arrival-notice/photo-upload");
    const f = (name: string, type: string) => ({ name, type });
    // 电脑 Chrome 选 iPhone 原图：type=image/heic → 不加（压不了、画不出小图，传上去是破图）
    const a = pickPhotos([f("a.jpg", "image/jpeg"), f("IMG_1.HEIC", "image/heic"), f("b.pdf", "application/pdf")], 20);
    assert.deepEqual(a.take.map((x) => x.name), ["a.jpg"]);
    assert.match(a.note, /^这次选了 3 个文件，加了 1 张。/);
    assert.match(a.note, /1 张是 HEIC 格式（苹果手机原图），电脑浏览器显示不了：IMG_1\.HEIC。请在手机上直接传，或先转成 JPG 再加/);
    assert.match(a.note, /1 个不是能识别的图片：b\.pdf/, "不是图片的也要说出来（原来悄悄丢）");
    // Windows 没装 HEIF 扩展：type 是空串，只能看扩展名
    assert.equal(isHeicFile(f("x.heif", "")), true);
    assert.equal(isHeicFile(f("x.HEIC", "application/octet-stream")), true);
    // 手机浏览器转好的 JPG 万一还叫 .HEIC：信类型，不挡
    assert.equal(isHeicFile(f("IMG_2.HEIC", "image/jpeg")), false);
    assert.deepEqual(pickPhotos([f("IMG_2.HEIC", "image/jpeg")], 20), { take: [f("IMG_2.HEIC", "image/jpeg")], note: "" });
    // 已有 18 张，再选 5 个（3 张 jpg + 2 个 type 为空的 heic）：原来提示「这次选了 3 张」、两个 heic 一个字不提
    const b = pickPhotos([f("p1.jpg", "image/jpeg"), f("p2.jpg", "image/jpeg"), f("p3.jpg", "image/jpeg"), f("h1.heic", ""), f("h2.heic", "")], 2);
    assert.deepEqual(b.take.map((x) => x.name), ["p1.jpg", "p2.jpg"]);
    assert.match(b.note, /^这次选了 5 个文件，加了 2 张。/);
    assert.match(b.note, /2 张是 HEIC 格式[^；]*h1\.heic、h2\.heic/);
    assert.match(b.note, /一条最多 20 张照片，多出来的 1 张没加：p3\.jpg/);
    // 全都正常、没超：不出提示；名单超过 5 个写「等」
    assert.equal(pickPhotos([f("a.png", "image/png")], 20).note, "");
    const many = pickPhotos(Array.from({ length: 7 }, (_, i) => f(`z${i}.txt`, "text/plain")), 20);
    assert.match(many.note, /7 个不是能识别的图片：z0\.txt、z1\.txt、z2\.txt、z3\.txt、z4\.txt 等/);
    // 后端兜底（上线前打开的老页面照样能传 HEIC）
    const routes = read("apps/api/src/modules/arrival-notices/routes.ts");
    assert.match(routes, /if \(\/\^image\\\/hei\[cf\]\/i\.test\(mime\)\) \{ fail\(res, 400/, "上传接口要挡 HEIC");
  });

  await check("A19 修复第 1 轮：「正在处理」按 id 各管各的 —— A 卡片还在请求时，B 结束不许把 A 的按钮放开", () => {
    const v = view();
    assert.ok(!/\[busyId, setBusyId\]/.test(v), "还是全页一个 busyId");
    assert.ok(!/setBusyId\(null\)/.test(v), "finally 里不许一把清空（会放开别的卡片）");
    const run = sliceBetween(v, "const run = async (id: string, work: () => Promise<void>) => {", "\n  };");
    assert.match(run, /setBusyIds\(\(cur\) => new Set\(cur\)\.add\(id\)\);/);
    assert.match(run, /finally \{[\s\S]*setBusyIds\(\(cur\) => \{ const next = new Set\(cur\); next\.delete\(id\); return next; \}\);/, "finally 只删自己");
    assert.match(v, /busy=\{busyIds\.has\(n\.id\)\}/);
    assert.match(v, /disabled=\{props\.busyIds\.has\(img\.id\)\}/, "照片「保存」看自己那张");
  });

  await check("A15 F06：物流轨迹按运单 id 查（号在「运单管理」可能改过）", () => {
    const v = view();
    assert.match(v, /const trackShipmentId = formal \|\| inbound \? n\.shipmentId : null;/);
    assert.match(v, /openShipmentTrack\(\{ shipmentId: trackShipmentId \}\)/);
    assert.ok(!/openShipmentTrack\(\{ trackingNo:/.test(v), "还在按号查轨迹");
    assert.ok(!/trackingNo: n\.trackingNo/.test(v), "还在按登记时的号查轨迹");
  });

  await check("A16 F01 / F02 / F11 / G01 页面那半：预报单提醒 + 确认后带 orderId 转、不藏按钮；没通知就转先提醒；货型能选并传给后端；换唛头提醒、标已通知带唛头", async () => {
    const api = await import("../apps/web/src/services/arrival-notice-api");
    const d = { clientId: "A", trackingNo: "T", itemName: "", packageCount: "", weightKg: "", volumeM3: "", transportMode: "" as const, cargoType: "sensitive" as const, domesticTrackingNo: "", warehouseId: "", arrivedAt: "", remark: "" };
    assert.equal(api.draftToBody(d).cargoType, "sensitive", "货型要传给后端（原来一律普货）");
    assert.equal(api.draftToBody({ ...d, cargoType: "normal" }).cargoType, "normal", "普货也要明着传（不传后端会当老页面、沿用库里的）");
    // 发给后端的请求体
    const bodies = await captureBodies(async () => {
      await api.convertArrivalNotice("n1", "formal", ["o1", "o2"]);
      await api.convertArrivalNotice("n2", "inbound", []);
      await api.setArrivalNoticeNotified("n3", true, "ABC");
      await api.setArrivalNoticeNotified("n4", true, null);
      await api.setArrivalNoticeNotified("n5", false, "ABC");
    });
    assert.deepEqual(bodies.map((b) => b.body), [
      { id: "n1", to: "formal", acknowledgedPrealertIds: ["o1", "o2"] },
      { id: "n2", to: "inbound" },
      { id: "n3", notified: true, clientId: "ABC" },
      { id: "n4", notified: true, clientId: null },
      { id: "n5", notified: false },
    ]);
    assert.ok(bodies.every((b) => b.url.includes("/staff/arrival-notices/")));
    const v = view();
    // F11
    assert.match(v, /CARGO_TYPES\.map\(\(c\) => <option key=\{c\} value=\{c\}>\{CARGO_TYPE_ZH\[c\]\}<\/option>\)/);
    assert.match(v, /cargoType: cargoTypeOf\(n\.cargoType\),/, "修改时带出库里的货型");
    assert.match(v, /\["货型", CARGO_TYPE_ZH\[cargoTypeOf\(n\.cargoType\)\]\]/, "卡片上显示货型");
    // F01：卡片提醒、确认框列出来、确认后带 orderId 转；按钮不藏（R2）
    assert.match(v, /const prealerts = n\.prealertMatches \?\? \[\];/);
    assert.match(v, /const matches = n\.prealertMatches \?\? \[\];/);
    assert.match(v, /await convertArrivalNotice\(n\.id, to, matches\.map\(\(m\) => m\.orderId\)\);/, "转运单要带上员工确认过的预报单");
    const conv = sliceBetween(v, "const onConvert = ", "\n  };");
    assert.match(conv, /确定是两票不同的货才点确定/);
    // 修复第 1 轮：待入库 → 正式不会多建运单（同一张），确认框不许说「在这里转会多出一张运单」，跟卡片上「可能有两张、删掉多的」一个说法
    const askExpr = sliceBetween(conv, "const prealertAsk = ", ";\n");
    assert.match(askExpr, /: to === "formal" && n\.convertedTo === "inbound"\s*\? `[^`]*转待入库时已经建过运单，现在可能有两张运单。转正式用的是同一张、不会再多建[^`]*`\s*: `[^`]*在这里转会多出一张运单/, "待入库转正式要换一种说法");
    assert.match(conv, /catch \(e\) \{\s*void reloadLatest\(\);[^\n]*\n\s*throw e;/, "转运单被挡要刷出最新的再报原话");
    const btns = v.split("\n").filter((l) => /onConvert\("(formal|inbound)"\)/.test(l));
    assert.equal(btns.length, 2);
    for (const l of btns) assert.ok(!/prealert/i.test(l), `转单按钮不许按预报单藏：${l.trim()}`);
    assert.match(v, /客户报过预报单 \$\{prealerts\.map\(prealertLabel\)/);
    assert.match(v, /客户另外报过预报单 \$\{prealerts\.map\(prealertLabel\)/);
    assert.match(v, /const matches = item\.prealertMatches \?\? \[\];/, "存完的提示也要带上");
    // F02
    assert.match(conv, /还没标「已通知客户」。通知完记得回来点「标为已通知客户」/);
    // G01（R8：原来没唛头、这次补上的不提醒）
    assert.match(v, /const clientChangedAfterNotify = Boolean\(editing && notifiedAt && savedClient !== null && draftClient !== savedClient\);/);
    assert.match(v, /clientChangedAfterNotify \? <small className="an-warn">/);
    assert.match(v, /if \(clientChangedAfterNotify && !item\.notifiedAt\) savedNoteRef\.current = CLIENT_CHANGED_NOTE;/, "改回未通知要按接口真回来的说");
    assert.match(v, /await setArrivalNoticeNotified\(n\.id, !n\.notifiedAt, n\.clientId\);/, "标已通知要带上看到的唛头");
  });

  await check("A17 G03 小图：canvas 先铺写死的白底（不许 CSS 变量，教训 23）；传照片带上小图；上传接口有小图才带那两个字段", async () => {
    const thumb = read("apps/web/src/modules/arrival-notice/photo-thumb.ts");
    assert.match(thumb, /ctx\.fillStyle = "#ffffff";\s*ctx\.fillRect\(/, "透明 PNG 不铺白底会变黑底");
    // 注释里写着「不能用 var(--white)」，只查代码
    const thumbCode = thumb.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!thumbCode.includes("var(--"), "canvas 不认 CSS 变量");
    assert.match(thumb, /toDataURL\("image\/jpeg", THUMB_QUALITY\)/);
    assert.match(thumb, /base64\.length > THUMB_MAX_BASE64\) return null/);
    const { THUMB_MAX_BASE64 } = await import("../apps/web/src/modules/arrival-notice/photo-thumb");
    assert.equal(THUMB_MAX_BASE64, 200_000, "跟后端约定的小图上限");
    const routes = read("apps/api/src/modules/arrival-notices/routes.ts");
    assert.match(routes, /THUMB_MAX_BASE64 = 200_000/, "后端小图上限变了，前端 photo-thumb.ts 跟着改");
    const { makeThumb } = await import("../apps/web/src/modules/arrival-notice/photo-thumb");
    assert.equal(await makeThumb({ fileName: "a.jpg", mime: "image/jpeg", base64: "AAAA" }), null, "没有浏览器画布时返回 null，不挡上传");
    const v = view();
    assert.match(v, /const thumb = await makeThumb\(img\);/);
    assert.match(v, /uploadArrivalNoticeImage\(noticeId, img, thumb\)/, "传照片要带上小图");
    const api = await import("../apps/web/src/services/arrival-notice-api");
    const bodies = await captureBodies(async () => {
      await api.uploadArrivalNoticeImage("n1", { fileName: "a.jpg", mime: "image/jpeg", base64: "BIG" }, { mime: "image/jpeg", base64: "SMALL" });
      await api.uploadArrivalNoticeImage("n1", { fileName: "b.png", mime: "image/png", base64: "BIG2" }, null);
    });
    assert.deepEqual(bodies.map((b) => b.body), [
      { noticeId: "n1", fileName: "a.jpg", mime: "image/jpeg", contentBase64: "BIG", thumbBase64: "SMALL", thumbMime: "image/jpeg" },
      { noticeId: "n1", fileName: "b.png", mime: "image/png", contentBase64: "BIG2" },
    ]);
  });

  await check("A18 G01 修复审查：改唛头存上了、照片没传完时，「改回未通知」那句跟着报错说；再点保存传完，最后的提示也还带着", async () => {
    const { photoFailMessage, CLIENT_CHANGED_NOTE, MAX_NOTICE_IMAGES } = await import("../apps/web/src/modules/arrival-notice/photo-upload");
    assert.equal(CLIENT_CHANGED_NOTE, "唛头换了，这条已改回「未通知」，记得通知新客户");
    // 两条失败路都要带上那句
    const failed = photoFailMessage({ limitReached: false, failed: 1, firstError: "网断了" }, CLIENT_CHANGED_NOTE);
    assert.equal(failed, `资料已保存（${CLIENT_CHANGED_NOTE}），但有 1 张照片没传上（网断了），再点「保存」接着传`);
    const full = photoFailMessage({ limitReached: true, failed: 2, firstError: null }, CLIENT_CHANGED_NOTE);
    assert.ok(full.startsWith(`资料已保存（${CLIENT_CHANGED_NOTE}）。一条到货通知最多 ${MAX_NOTICE_IMAGES} 张照片`), full);
    // 没换唛头：文案跟原来一字不差
    assert.equal(photoFailMessage({ limitReached: false, failed: 2, firstError: "x" }, ""), "资料已保存，但有 2 张照片没传上（x），再点「保存」接着传");
    assert.equal(photoFailMessage({ limitReached: true, failed: 2, firstError: null }, ""), `资料已保存。一条到货通知最多 ${MAX_NOTICE_IMAGES} 张照片，已经满了，还有 2 张没传：请点「移除」去掉多出来的（或者先删掉已有的照片）再保存`);
    // 页面：那句记进 ref（第二次保存时 base 已是新唛头、notifiedAt 已是 null，算不出来）；两条失败路和最后的提示都读它
    const v = view();
    const submit = sliceBetween(v, "const submit = async () => {", "\n  };");
    assert.match(submit, /if \(savedNoteRef\.current\) doneMessage = `已保存。\$\{savedNoteRef\.current\}`;/, "再点保存传完时，最后的提示也要带上那句");
    assert.match(submit, /else if \(item\.notifiedAt\) savedNoteRef\.current = "";/, "中间又被标了已通知，那句就不成立了");
    const limit = sliceBetween(submit, "if (r.limitReached) {", "return;");
    assert.match(limit, /setError\(photoFailMessage\(r, savedNoteRef\.current\)\);/, "传满那条路丢了那句");
    const fail = sliceBetween(submit, "if (r.failed > 0) {", "return;");
    assert.match(fail, /setError\(photoFailMessage\(r, savedNoteRef\.current\)\);/, "没传上那条路丢了那句");
    assert.ok(!/setError\(`资料已保存/.test(submit), "失败提示不许再自己拼（会漏掉那句）");
    assert.ok(!/doneMessage = "已保存。唛头换了/.test(submit), "不许只在当次保存里说一遍");
    // ref 跟着弹窗实例走：每开一次弹窗换一个实例，不会带进下一条
    assert.match(v, /const savedNoteRef = useRef\(""\);/);
  });

  await check("A20 修复第 2 轮：保存 / 传照片期间修改弹窗里的每一个输入框、下拉、备注都是灰的（传照片那几十秒改的字存不上、还会提示「已保存」）", () => {
    const v = view();
    const form = sliceBetween(v, '<div className="an-form">', '<div className="an-form-photos">');
    // 一个控件写在一行里（onChange 里有「=>」，不能拿 [^>]* 截标签）
    const controls = form.split("\n").filter((line) => /<(input|select|textarea)\b/.test(line));
    assert.equal(controls.length, 12, `表里的输入控件数变了（${controls.length}），对一下这条测试`);
    const loose = controls.filter((c) => !c.includes("disabled={saving}"));
    assert.deepEqual(loose, [], "保存中还能改的控件");
  });

  await check("A21 修复第 2 轮：选照片只收电脑上显示得了的格式（TIFF / SVG 不加、说清原因）；后端上传接口同一份白名单兜底", async () => {
    const { pickPhotos, DISPLAYABLE_PHOTO_TYPES, isDisplayablePhotoType } = await import("../apps/web/src/modules/arrival-notice/photo-upload");
    const { PHOTO_MIME_ALLOWED } = await import("../apps/api/src/modules/arrival-notices/routes");
    const f = (name: string, type: string) => ({ name, type });
    const r = pickPhotos([f("a.jpg", "image/jpeg"), f("scan.tif", "image/tiff"), f("logo.svg", "image/svg+xml"), f("b.webp", "image/webp"), f("x.heic", "image/heic")], 20);
    assert.deepEqual(r.take.map((x) => x.name), ["a.jpg", "b.webp"], "TIFF / SVG 不能加进框（Chrome 压不了、存成 .jpg 是破图）");
    assert.match(r.note, /^这次选了 5 个文件，加了 2 张。/);
    assert.match(r.note, /2 张的格式电脑上显示不了（只认 JPG \/ PNG \/ GIF \/ WebP \/ BMP）：scan\.tif、logo\.svg。请先转成 JPG 再加/);
    assert.match(r.note, /1 张是 HEIC 格式/, "HEIC 照旧单独说");
    for (const t of ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "IMAGE/PNG"]) assert.equal(isDisplayablePhotoType(t), true, t);
    for (const t of ["image/tiff", "image/svg+xml", "image/x-icon", ""]) assert.equal(isDisplayablePhotoType(t), false, t);
    assert.deepEqual([...PHOTO_MIME_ALLOWED].sort(), [...DISPLAYABLE_PHOTO_TYPES].sort(), "页面和后端的白名单要同一份");
    // 白名单里每一种 image-storage.ts 都认得扩展名（认不出的会被存成 .jpg、按 image/jpeg 发出去）
    const storage = read("apps/api/src/modules/orders/image-storage.ts");
    for (const t of PHOTO_MIME_ALLOWED) assert.ok(storage.includes(`"${t}":`), `image-storage.ts 不认 ${t}`);
  });

  console.log(`\n到货通知（不连库）${passed} 项全部通过`);
  // 后端 routes 一 import 就带上了 prisma，不连库也会挂着句柄，直接退出
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
