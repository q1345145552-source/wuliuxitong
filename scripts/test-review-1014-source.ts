/**
 * 2026-10-14 全系统审查修复 —— 不连库的回归（真函数 + 按查询自己那一段切源码）。连库的在 test-review-1014-db.ts，
 * 超管批量导入在 test-cargo-regressions.ts、客服卡片详情在 test-cs-chat-ui-behavior.ts U27c、拆派仓重复签收轨迹在 test-chaipai-db.ts V7。
 *
 *   T1 手写原因抹柜号（maskFreeTextForClient 真函数）；客户钱包流水、代理仓库版柜详情接上了这一道
 *   T2 客服对话：单子改号也算「有变化」，卡片换成新号（mergeChatMessages 真函数）
 *   T3 尾端派送能挑的状态只有一份：页面候选、后端建单复查都用它；后端复查在「已在这张单里就跳过」之后
 *   T4 整柜管理：详情认主人；列表 + 静默刷新用 createQueryGate（失败的请求不作废成功的，Codex 第 2 轮）
 *   T5 装柜「可选运单」按父单号归拢已装子单，不再去只有父单的列表里找子单
 *   T6 确认收货：国内单号员工真动过才发（跟草稿建出来那一刻比，Codex 第 2 轮）
 *   T7 普通版集货取消：记录的原状态用锁后重读的
 *   T8 装柜单号自动编号按北京日期（固定时刻验）
 *   T9 集货编辑保存后先刷新详情再关编辑框（不然马上再编辑会误报 409）；T9b 超管集货详情按「这一次查看」认先后
 *   T10 客户批量下单预览：发货日期跟后端同一个规矩
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** 从 from 切到 to（不含）；找不到就失败，免得切错段还全绿 */
function slice(file: string, from: string, to: string): string {
  const src = read(file);
  const i = src.indexOf(from);
  assert.ok(i >= 0, `${file} 里找不到「${from}」，这条测试要跟着改`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j > i, `${file} 里「${from}」后面找不到「${to}」`);
  return src.slice(i, j);
}
let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
}

async function main(): Promise<void> {
  await check("T1 手写原因抹柜号：「柜号：」后面的、标准样子的、本公司柜号名单里的都抹，别的字留着", async () => {
    const { maskFreeTextForClient, maskLabeledContainerNo } = await import("../apps/api/src/modules/core/client-privacy");
    // 「柜号：」后面一直抹到标点（09-29 起客户仓库版详情就这么抹），所以「已满」放在逗号后面
    const out = maskFreeTextForClient("作废预报单退款（柜号：L2608219129，已满，改装 ZZCTN0001 那柜，原来 MSKU1234565）", ["ZZCTN0001"]);
    for (const no of ["L2608219129", "ZZCTN0001", "MSKU1234565"]) assert.ok(!out.includes(no), `${no} 没抹：${out}`);
    assert.ok(out.startsWith("作废预报单退款（") && out.includes("已满") && out.includes("那柜"), `别的字也被抹了：${out}`);
    assert.equal(maskFreeTextForClient("客户不发了"), "客户不发了");
    assert.equal(maskLabeledContainerNo("柜号: MEDU 123456 7，明天开"), "柜号（不对外显示），明天开");
  });

  await check("T1 客户钱包流水、代理仓库版柜详情的取消 / 驳回原因 / 状态记录都走抹柜号那一道（原来只去「管理员」/ 原样给）", () => {
    const ledger = slice("apps/api/src/modules/client-compliance/routes.ts", 'app.get("/client/wallet/ledger"', 'app.get("/client/wallet/recharges"');
    assert.match(ledger, /companyContainerNosForMasking\(auth\.companyId, \[auth\.userId\]\)/, "钱包流水没取本公司柜号名单（看的人自己的运单号不抹）");
    assert.match(ledger, /remark: hideOperatorInRemark\(maskFreeTextForClient\(r\.remark \?\? "", maskNos\), "client"\)/, "钱包流水备注没抹柜号");
    const agent = slice("apps/api/src/modules/agent-portal/routes.ts", 'app.get("/agent/whr/plan-detail"', 'app.get("/agent/clients"');
    assert.match(agent, /companyContainerNosForMasking\(auth\.companyId, clientIds\)/);
    assert.match(agent, /paymentRejectReason: maskText\(pa\.paymentRejectReason\)/, "代理：付款驳回原因原样给");
    assert.match(agent, /cancelReason: maskText\(pa\.cancelReason\)/, "代理：取消原因原样给");
    assert.match(agent, /remark: remarkForAgent\(maskLabeledContainerNo\(sl\.remark \?\? ""\), maskNos\)/, "代理：状态记录没按柜号名单 /「柜号：」抹");
    assert.doesNotMatch(agent, /cancelReason: pa\.cancelReason|paymentRejectReason: pa\.paymentRejectReason/);
  });

  await check("T2 客服对话：同一条消息单子改了号 → 换成新号；什么都没变 → 原数组不动（不白白重画）", async () => {
    const { mergeChatMessages } = await import("../apps/web/src/services/cs-chat-api");
    const old: any = { id: "m1", createdAt: "2026-10-14T00:00:00.000Z", ref: { type: "shipment", id: "s1", no: "XT001", title: null, status: "loaded", gone: false } };
    const renamed: any = { ...old, ref: { ...old.ref, no: "XT009" } };
    assert.equal(mergeChatMessages([old], [renamed])[0].ref?.no, "XT009", "改号被当成没变化（原来只比状态）");
    const cur = [old];
    assert.equal(mergeChatMessages(cur, [{ ...old, ref: { ...old.ref } }]), cur);
  });

  await check("T2b 客服卡片按运单 id 找：后端认 id 却没找到就不再按旧单号找；只有老后端（回来的单上没有 shipmentId）才退回（Codex 第 9 轮）", () => {
    const api = slice("apps/web/src/services/business-api.ts", "export async function fetchClientOrderByShipmentId(", "export async function fetchClientOrderByTrackingNo(");
    assert.match(api, /supported: data\.supportsShipmentIdQuery === true,/);
    const detail = read("apps/web/src/modules/cs-chat/ChatRefDetail.tsx");
    assert.match(detail, /const item = byId\.item \?\? \(byId\.supported \? null : await fetchClientOrderByTrackingNo\(chatRef\.no\)\);/);
    // 后端那头每条都带 shipmentId（老后端没有这个字段，才能靠它分清）
    const orders = slice("apps/api/src/modules/orders/routes.ts", 'app.get("/client/orders"', 'app.get("/client/prealerts"');
    assert.match(orders, /shipmentId: ship\?\.id \?\? null,/);
    assert.match(orders, /ok\(res, \{ items: itemsWithImages, page, pageSize, total, supportsShipmentIdQuery: true \}\);/, "后端没明说认按运单 id 找");
  });

  await check("T2 后端：整柜卡片也给现在的号（原来只给状态，卡片永远是发消息那一刻的号）", () => {
    const live = slice("apps/api/src/modules/cs-chat/routes.ts", "async function loadRefLive(", "return live;");
    assert.match(live, /shipment: \{ select: \{ currentStatus: true, trackingNo: true/);
    assert.match(live, /live\.set\(`fcl:\$\{c\.id\}`, \{ status: ship\.currentStatus, no: ship\.trackingNo \}\)/);
  });

  await check("T3 尾端派送能挑的状态只有一份：页面候选、后端复查都用它；后端复查用锁后重读的状态、放在「已在这张单里」之后", async () => {
    const { LASTMILE_DISPATCHABLE_STATUSES } = await import("../packages/shared-types/shipment-status");
    assert.deepEqual([...LASTMILE_DISPATCHABLE_STATUSES], ["inWarehouseTH", "deliveryBooked", "outForDelivery", "delivered"]);
    assert.match(read("apps/web/src/services/business-api.ts"), /const LASTMILE_STATUSES = LASTMILE_DISPATCHABLE_STATUSES\.join\(","\);/);
    const create = slice("apps/api/src/modules/admin-ops/routes.ts", 'app.post("/admin/lastmile/orders"', "const toMove = movableRows");
    const skip = create.indexOf("skipped.push(ownShipment.trackingNo)");
    const guard = create.indexOf("LASTMILE_DISPATCHABLE_STATUSES as string[]).includes(ownShipment.currentStatus)");
    assert.ok(skip > 0 && guard > skip, "后端没复查状态，或者复查放在了「已在这张单里就跳过」前面（编辑老单会被别的票卡住）");
    assert.match(create.slice(guard), /throw new LastmileConflictError\(`运单 \$\{ownShipment\.trackingNo\} 现在不在泰国仓/);
  });

  await check("T4 整柜管理：取详情的三条路（点开详情 / 实时推送重拉 / 保存冲突后重拉）共用一道门闩，按「这一次查看」认（柜 id + 第几次点开），返回 / 删柜 / 加载失败都清掉（Codex 第 4、5 轮）", () => {
    const f = "apps/web/src/components/fcl/FclContainerWorkbench.tsx";
    const src = read(f);
    assert.match(src, /const detailGate = useRef\(createQueryGate<string \| null>\(\)\)\.current;/);
    const close = slice(f, "const closeDetail = () => {", "};");
    assert.match(close, /detailViewRef\.current = null;/, "返回列表没清掉「这一次查看」");
    const open = slice(f, "const openDetail = async (containerId: string) => {", "/** 下载模板");
    assert.match(open, /const view = `\$\{containerId\}#\$\{\+\+detailVisitRef\.current\}`;\s*detailViewRef\.current = view;/, "每次点开没记新的查看编号");
    assert.match(open, /const ticket = detailGate\.begin\(view\);/);
    assert.match(open, /const d = await fetchFclContainerDetail\(containerId\);\s*if \(!detailGate\.accept\(ticket, detailViewRef\.current\)\) return;\s*applyDetail\(d\);/);
    assert.match(open, /if \(ticket\.key !== detailViewRef\.current \|\| detailGate\.superseded\(ticket\)\) return;/, "上一次查看的请求失败晚到，会把这一次打开的踢回列表");
    const live = slice(f, "const openId = selectedIdRef.current;", "await Promise.all([");
    assert.match(live, /const ticket = detailGate\.begin\(view\);/, "实时推送重拉详情没按这一次查看领号");
    assert.match(live, /detailRef\.current\?\.containerId === openId && detailGate\.accept\(ticket, detailViewRef\.current\)\) applyDetail\(d\)/);
    const conflict = slice(f, "if (editingId && view && selectedIdRef.current === editingId && /刚刚被别人改过/.test(msg)) {", "} catch { /* 刷新失败不盖掉");
    assert.match(conflict, /const ticket = detailGate\.begin\(view\);/, "保存冲突后重拉详情没领号");
    assert.match(conflict, /if \(detailGate\.accept\(ticket, detailViewRef\.current\)\) \{\s*applyDetail\(latest\);\s*setEditingVersion/, "保存冲突后的重拉晚到会把别的柜盖成这个柜");
    assert.match(conflict, /\} else if \(detailGate\.covered\(ticket, detailViewRef\.current\)\) \{[\s\S]*?setEditingVersion\(detailRef\.current\?\.updatedAt/, "实时推送抢先拉回了新详情，版本号没跟上，弹窗里再存还会被拦（dsh 第 9 轮）");
    // 改详情只许走 applyDetail（它同步写「最后用上的那份」，Codex 第 9 轮：靠渲染时 detailRef = detail 跟上，setDetail 之后、重新渲染之前读到的是旧的）；
    // 用真数据调 applyDetail 只有这三处、改选中柜子只有 openDetail / closeDetail 两处 —— 多出来的就是没认主人的
    const apply = slice(f, "const applyDetail = (next: FclContainerDetail | null) => {", "};");
    assert.match(apply, /detailRef\.current = next;\s*setDetail\(next\);/);
    assert.equal((src.match(/setDetail\(/g) ?? []).length, 1, "有地方绕过 applyDetail 直接 setDetail");
    assert.doesNotMatch(src, /detailRef\.current = detail;/, "detailRef 又改回靠渲染跟上了");
    const sets = (src.match(/applyDetail\((?!null\))[^)]*\)/g) ?? []).sort();
    assert.deepEqual(sets, ["applyDetail(d)", "applyDetail(d)", "applyDetail(latest)"], `取详情的地方变了：${sets.join(", ")}`);
    assert.equal((src.match(/setSelectedId\(/g) ?? []).length, 2, "有别的地方直接改选中的柜（要走 openDetail / closeDetail，不然查看编号对不上）");
  });

  await check("T4b 列表 + 静默刷新的门闩（createQueryGate 真函数，按 Codex 第 2 轮说的几种先后顺序走一遍）", async () => {
    const { createQueryGate, createRequestGate } = await import("../apps/web/src/modules/shared/request-gate");
    const A = { q: "A" }, B = { q: "B" };
    // ① 前台按 B 查（1 号）→ 推送触发静默刷新（2 号）→ 前台成功 → 静默失败：前台结果要用上
    let g = createQueryGate<typeof A>();
    let fg = g.begin(B); const bg = g.begin(B);
    assert.equal(g.accept(fg, B), true, "后启动的静默刷新把成功的前台结果作废了（失败的请求不该作废谁）");
    void bg; // 静默那次失败：什么都不做
    // 对照：老写法「只认最新一次」在同一顺序下会把前台扔掉 —— 这就是 Codex 报的那条
    const old = createRequestGate(); const o1 = old.begin(); old.begin();
    assert.equal(old.isCurrent(o1), false, "（对照）只认最新一次的老门闩在这个顺序下扔掉前台");
    // ② 静默（2 号）先成功显示了，前台（1 号）才回来：旧的不许盖新的
    g = createQueryGate<typeof A>();
    fg = g.begin(B); const bg2 = g.begin(B);
    assert.equal(g.accept(bg2, B), true);
    assert.equal(g.accept(fg, B), false, "更旧的前台结果盖掉了已经显示的新结果");
    // ③ 连着查 A、B：A 回来时条件已经是 B → 扔；B 回来 → 用
    g = createQueryGate<typeof A>();
    const ta = g.begin(A), tb = g.begin(B);
    assert.equal(g.accept(ta, B), false, "旧条件 A 的结果盖掉了现在的条件 B");
    assert.equal(g.accept(tb, B), true);
    // ④ 条件切走以后旧条件的响应才回来：扔（哪怕它是最新领的号）
    g = createQueryGate<typeof A>();
    const t4 = g.begin(A);
    assert.equal(g.accept(t4, B), false);
    // ⑤ 同一号不会用两次
    g = createQueryGate<typeof A>();
    const t5 = g.begin(A);
    assert.equal(g.accept(t5, A), true);
    assert.equal(g.accept(t5, A), false);
    // ⑥ 前台（1 号）在路上，静默（2 号）先成功显示了，前台才失败：它的报错不用再说（Codex 第 3 轮）；没被新结果盖过的失败照常报
    g = createQueryGate<typeof A>();
    const f1 = g.begin(B), s2 = g.begin(B);
    assert.equal(g.superseded(f1), false, "还没有更新的结果，失败该照常报");
    assert.equal(g.accept(s2, B), true);
    assert.equal(g.superseded(f1), true, "更新的结果已经显示了，旧请求失败还弹「加载失败」");
    // ⑦ 详情（按柜号当条件）：A 保存冲突后的重拉在路上，人已经换到 B、B 先显示了 —— A 晚到不许把 B 盖成 A
    const d = createQueryGate<string | null>();
    const ta2 = d.begin("A");
    const tb2 = d.begin("B");
    assert.equal(d.accept(tb2, "B"), true);
    assert.equal(d.accept(ta2, "B"), false, "别的柜的详情晚到盖掉了现在选中的柜");
    // ⑧ 同一个柜：实时重拉（旧）在路上，重新点开（新）先回来 —— 旧的晚到不许盖新的
    const d2 = createQueryGate<string | null>();
    const oldLive = d2.begin("A"), reopen = d2.begin("A");
    assert.equal(d2.accept(reopen, "A"), true);
    assert.equal(d2.accept(oldLive, "A"), false, "旧的实时重拉结果盖掉了重新点开拿到的新结果");
    // ⑨ 点开 A（第 1 次）→ 没等回来就返回 → 再点开 A（第 2 次）：第 1 次的请求先成功 / 先失败都不算数，第 2 次照常显示（Codex 第 5 轮）
    const d3 = createQueryGate<string | null>();
    const v1 = d3.begin("A#1");
    const v2 = d3.begin("A#2");
    assert.equal(d3.accept(v1, "A#2"), false, "上一次查看的成功结果被当成这一次的");
    assert.ok(v1.key !== "A#2", "上一次查看的失败会被当成这一次的、把人踢回列表");
    assert.equal(d3.accept(v2, "A#2"), true, "这一次查看自己的结果反而没显示");
    // ⑩ 返回列表以后（查看编号清空）回来的结果一律不用
    const d4 = createQueryGate<string | null>();
    const v3 = d4.begin("B#3");
    assert.equal(d4.accept(v3, null), false);
    // ⑪ 保存后自己去刷新（1 号），同一次保存触发的实时推送也去刷新（2 号）、而且先成功显示了：1 号回来被扔掉，但「刷新到了」（Codex 第 7 轮）
    const d5 = createQueryGate<string | null>();
    const mine = d5.begin("T#1"), push = d5.begin("T#1");
    assert.equal(d5.covered(mine, "T#1"), false, "还没有任何结果显示，不算刷新到");
    assert.equal(d5.accept(push, "T#1"), true);
    assert.equal(d5.accept(mine, "T#1"), false);
    assert.equal(d5.covered(mine, "T#1"), true, "更新的明细已经显示了，却报「没刷新出来」");
    assert.equal(d5.covered(mine, "T#2"), false, "换了一次查看就不算");
    // ⑫ 1 号自己用上了也算；后发的 3 号还没回来不影响
    const d6 = createQueryGate<string | null>();
    const a1 = d6.begin("T#1"); d6.begin("T#1");
    assert.equal(d6.accept(a1, "T#1"), true);
    assert.equal(d6.covered(a1, "T#1"), true);
  });

  await check("T4c 整柜列表接上这道门闩：按「现在的条件」收、失败不作废别人、「查询中」按在路上的前台请求个数关", () => {
    const list = slice("apps/web/src/components/fcl/FclContainerWorkbench.tsx", "const loadList = useCallback(", "}, [search, listGate]);");
    assert.match(list, /const ticket = listGate\.begin\(search\);/);
    assert.match(list, /const r = await fetchFclContainers\(search\);\s*if \(!listGate\.accept\(ticket, searchRef\.current\)\) return;\s*setRows/);
    assert.match(list, /pendingListRef\.current -= 1; if \(pendingListRef\.current === 0\) setLoading\(false\);/, "旧请求回来会提前关掉新请求的「查询中」");
    assert.doesNotMatch(list, /listSeqRef/);
    assert.match(list, /Object\.is\(ticket\.key, searchRef\.current\) && !listGate\.superseded\(ticket\)\) setToast/, "旧请求失败、新结果已显示时还弹「加载失败」");
    // 先失败弹了「加载失败」、后面的成功了：只收掉那一句（Codex 第 11 轮）
    assert.match(list, /setRows\(r\.items \?\? \[\]\);\s*\/\/[^\n]*\n\s*setToast\(\(prev\) => \(prev\.startsWith\(LIST_LOAD_FAILED\) \? "" : prev\)\);/, "后面成功了，前面那句「加载失败」还挂着");
  });

  await check("T5 装柜「可选运单」：已装子单按父单号从映射里归拢（原来去只有父单的列表里找子单，永远空）", () => {
    const f = read("apps/web/src/app/staff/container-loading/page.tsx");
    assert.doesNotMatch(f, /allShipments\.filter\(c => c\.parentTrackingNo === s\.trackingNo\)/);
    assert.match(f, /const loadedChildren = isParent \? \(loadedChildrenByParent\[s\.trackingNo\] \?\? \[\]\) : \[\];/);
    assert.match(f, /\(byParent\[row\.parentTrackingNo\] \?\?= \[\]\)\.push/);
    // 父单那一行的「已装柜(柜号)」也按子单装进的柜写（dsh 第 2 轮）；勾选不跟着变（剩下的件数还能再装）
    assert.match(f, /const loadedContainer = loadedShipments\[s\.id\]\s*\?\? \(loadedChildren\.length > 0 \? \[\.\.\.new Set\(loadedChildren\.map\(\(c\) => c\.manifestNo\)\)\]\.join\("、"\) : undefined\);/);
    assert.match(f, /const alreadyIn = existingShipmentIds\.has\(s\.id\);/);
    const map = slice("apps/api/src/modules/loading-manifests/routes.ts", 'app.get("/staff/loading-manifests/shipment-map"', "// 装柜详情");
    assert.match(map, /shipment: \{ select: \{ trackingNo: true, parentTrackingNo: true, packageCount: true \} \}/);
  });

  await check("T6 确认收货：国内单号员工真动过这一格才发 —— 跟草稿建出来那一刻比，不跟实时刷新后的新数据比（真函数）", async () => {
    const { buildPrealertDraft, receiveDomesticNoToSend } = await import("../apps/web/src/modules/staff/utils");
    const item = { id: "o1", products: [{ domesticTrackingNo: "货拉拉" }], domesticTrackingNo: null, transportMode: "sea" };
    const draft = buildPrealertDraft(item);
    assert.equal(receiveDomesticNoToSend(draft), undefined, "没动过就发了（框里默认是第一行产品的号「货拉拉」）");
    // 员工改了别的格（重量），草稿留着；这时同事把单号改成真号 SF123、页面实时刷新 —— 草稿还是旧的
    const edited = { ...draft, weightKg: 12 };
    assert.equal(receiveDomesticNoToSend(edited), undefined, "员工没碰单号，旧号被当成改过发回去（Codex 第 2 轮：会把同事刚改的真号盖掉）");
    assert.equal(receiveDomesticNoToSend({ ...edited, domesticTrackingNo: "  SF999 " }), "SF999", "员工真改了要发（去首尾空格）");
    assert.equal(receiveDomesticNoToSend({ ...edited, domesticTrackingNo: "  " }), undefined, "清空了不发（后端本来不收空号）");
    // 没记下起点的草稿（将来别处拼出来、漏了 domesticTrackingNoBase）：不知道改没改，不发（dsh 第 8 轮）
    const { domesticTrackingNoBase: _drop, ...noBase } = edited;
    assert.equal(receiveDomesticNoToSend({ ...noBase, domesticTrackingNo: "货拉拉" }), undefined, "没记起点的草稿把默认的「货拉拉」当成改过发出去了");
    // 请求里那两格：改过才带号，并且带「员工真改过」标记；没改什么都不带（Codex 第 4 轮：后端只认带标记的才同步运单）
    const { receiveDomesticFields } = await import("../apps/web/src/modules/staff/utils");
    assert.deepEqual(receiveDomesticFields(edited), {});
    assert.deepEqual(receiveDomesticFields({ ...edited, domesticTrackingNo: " SF999 " }), { domesticTrackingNo: "SF999", domesticTrackingNoEdited: true });
  });

  await check("T6b 调确认收货的页面都用这一个函数（员工「预报单审核」、超管「预报单管理」，grep 核对没有第三个）", () => {
    const callers = ["apps/web/src/app/staff/page.tsx", "apps/web/src/app/admin/prealerts/page.tsx"];
    for (const file of callers) {
      const f = slice(file, "await receiveStaffPrealert({", "batchNo: batchNo || undefined,");
      assert.match(f, /\.\.\.receiveDomesticFields\(draft\),/, `${file} 没用 receiveDomesticFields`);
      assert.doesNotMatch(f, /domesticTrackingNo:/, `${file} 又自己拼国内单号了`);
    }
    // 超管页自己有一份 buildPrealertDraft，也要记下草稿建出来那一刻的号
    assert.match(slice("apps/web/src/app/admin/prealerts/page.tsx", "function buildPrealertDraft(", "export default function"), /domesticTrackingNoBase: \(firstProduct\?\.domesticTrackingNo \|\| item\.domesticTrackingNo\) \?\? "",/);
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const found = execSync("grep -rl 'await receiveStaffPrealert(' apps/web/src", { cwd: ROOT, encoding: "utf8" }).trim().split("\n").sort();
    assert.deepEqual(found, [...callers].sort(), `调确认收货的页面变了：${found.join(", ")}`);
  });

  await check("T9 集货编辑保存成功：先把详情刷新回来再关编辑框（不然马上再点编辑拿的是旧明细，保存误报 409；dsh 第 5 轮）", () => {
    const client = slice("apps/web/src/app/client/consolidation/page.tsx", "await updateConsolidationPrealert({", "await loadTasks();");
    assert.match(client, /try \{\s*if \(opTaskId\) await loadDetail\(opTaskId\);[^\n]*\n\s*\} finally \{\s*setShowCreatePrealert\(false\);/, "客户页先关编辑框、后刷新详情");
    const admin = slice("apps/web/src/app/admin/consolidation/page.tsx", "await adminForceEditConsolidationPrealert({", "await loadTasks();");
    assert.match(admin, /try \{\s*if \(selectedTaskId\) refreshed = await loadDetail\(selectedTaskId\);\s*\} finally \{\s*setEditPrealert\(null\);\s*setToast\(refreshed \? "预报单已更新" : "预报单已更新，但下面的明细没刷新出来/, "超管页先关编辑框、后刷新详情；或明细没刷新出来也说「已更新」");
  });

  await check("T9b 超管集货详情按「这一次查看」认先后：实时推送的旧重拉晚到不盖保存后的新明细，失败不作废别人（Codex 第 6 轮；门闩语义见 T4b）", () => {
    const f = "apps/web/src/app/admin/consolidation/page.tsx";
    const sel = slice(f, "const selectTask = (id: string | null) => {", "};");
    assert.match(sel, /detailViewRef\.current = id \? `\$\{id\}#\$\{\+\+detailVisitRef\.current\}` : null;/, "点开任务没记新的查看编号");
    const load = slice(f, "const loadDetail = useCallback(", "}, [detailGate]);");
    assert.match(load, /const ticket = detailGate\.begin\(view\);/);
    assert.match(load, /const data = await fetchStaffConsolidationTaskDetail\(taskId\);\s*\/\/[^\n]*\n\s*if \(!detailGate\.accept\(ticket, detailViewRef\.current\)\) return detailGate\.covered\(ticket, detailViewRef\.current\);\s*setTaskDetail\(data\);\s*return true;/, "旧的重拉晚到还会盖掉新明细，或者更新的已经显示了还说没刷新到");
    assert.match(load, /catch \(e: any\) \{\s*if \(detailGate\.covered\(ticket, detailViewRef\.current\)\) return true;[^\n]*\n\s*if \(ticket\.key !== detailViewRef\.current\) return false;/);
    // 改选中任务只走 selectTask（别处直接 setSelectedTaskId 会让查看编号对不上）
    assert.equal((read(f).match(/setSelectedTaskId\(/g) ?? []).length, 1, "有别的地方直接改选中的任务");
  });

  await check("T10 客户批量下单预览：发货日期跟后端同一个规矩，看不懂 / 不存在的日子当场标红不让提交（dsh 第 6 轮）", async () => {
    const { normalizeRows, isRowBad } = await import("../apps/web/src/modules/client-import/import-rows");
    const base = { "仓库": "义乌仓", "运输方式": "海运", "品名": "鞋", "箱数": "2" };
    const one = (shipDate: string) => normalizeRows([{ ...base, "发货日期": shipDate }])[0];
    for (const bad of ["2026-02-31", "2026/10/14", "2026-2-1", "明天"]) {
      const r = one(bad);
      assert.ok(r.issues.some((i) => i.includes("发货日期")), `「${bad}」没标红：${JSON.stringify(r.issues)}`);
      assert.equal(isRowBad(r), true, `「${bad}」照样能提交`);
    }
    for (const good of ["2026-10-14", "46309", ""]) {
      const r = one(good);
      assert.ok(!r.issues.some((i) => i.includes("发货日期")), `「${good}」被误标：${JSON.stringify(r.issues)}`);
    }
  });

  await check("T8 装柜单号的日期按北京日期，用固定时刻验（不靠跑测试那一刻的钟点，dsh 复核第 1 轮）", async () => {
    const { manifestDateKey } = await import("../apps/api/src/modules/loading-manifests/routes");
    for (const [at, key] of [["2026-10-14T02:00:00Z", "20261014"], ["2026-10-14T15:59:59Z", "20261014"], ["2026-10-14T16:00:00Z", "20261015"], ["2026-10-14T20:00:00Z", "20261015"], ["2026-12-31T16:30:00Z", "20270101"]]) {
      assert.equal(manifestDateKey(new Date(at)), key, `${at}（北京 ${new Date(new Date(at).getTime() + 8 * 3600_000).toISOString().slice(0, 16)}）`);
    }
    assert.match(slice("apps/api/src/modules/loading-manifests/routes.ts", "async function issueManifestNo(", "const prefix"), /const dateKey = manifestDateKey\(now\);/);
    // 上面那几组固定时刻在北京时区的电脑上老写法也对得上（dsh 第 4 轮）—— 再钉死函数里不许用按本机时区取年月日的那几个
    const body = slice("apps/api/src/modules/loading-manifests/routes.ts", "export function manifestDateKey(", "async function issueManifestNo(");
    assert.doesNotMatch(body, /\.get(FullYear|Month|Date|Hours)\(/, "装柜单号日期又按本机时区取了");
  });

  await check("T7 普通版集货取消：记录里的原状态用锁后重读的 fresh.status", () => {
    const f = slice("apps/api/src/modules/consolidation/routes.ts", 'app.post("/staff/consolidation/tasks/cancel"', "return nowReceived;");
    assert.match(f, /fromStatus: fresh\.status,\s*toStatus: "cancelled"/);
    assert.doesNotMatch(f, /fromStatus: task\.status/);
  });

  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
