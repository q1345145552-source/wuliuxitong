/**
 * 封禁的唛头不进「挂单」的下拉（2026-10-17 老板「为什么客户账号已经封禁了，还是能加进去运单？」，选 A）—— 不连库。
 *
 * 一、modules/shared/client-ban.ts 几个函数直接调；提示那句跟后端拦下时那句一字不差（直接 import 后端那个函数比）。
 * 二、员工端 / 超管端两个大页面没法整页跑，按源码核：挂单的下拉都去掉了封禁的、打全了有提示。
 *     到货通知那个下拉是真跑组件测的（test-arrival-notice-editor.ts E4、test-arrival-notice-converted-edit.ts G4）。
 * 三、全站每一个唛头下拉（MarkPicker）点名：新加一个就会红，逼着想一下它要不要去掉封禁的。
 * 后端拦截在 test-client-ban-db.ts（连库）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BANNED_MARK_HINT, activeMarkOptions, bannedChangeHint, bannedClientIds, isBannedClient, withCurrentMark } from "../apps/web/src/modules/shared/client-ban";
import { BANNED_CLIENT_MESSAGE, CLIENT_BAN_ROW_WAIT, CLIENT_BAN_WAIT_MS, isBannedStatus } from "../apps/api/src/modules/core/client-ban";

let failures = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`✅ ${name}`); }
  catch (e) { failures += 1; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 6).join("\n   ")}`); }
}
const read = (rel: string) => fs.readFileSync(path.resolve(rel), "utf8");

check("U1 封禁口径跟后端一样（不是 active 就算）；没带 status 的（老接口 / 老页面）当没封", () => {
  assert.equal(isBannedClient({ status: "inactive" }), true);
  assert.equal(isBannedClient({ status: "active" }), false);
  assert.equal(isBannedClient({}), false);
  assert.equal(isBannedClient({ status: null }), false);
  for (const s of ["active", "inactive", "disabled", ""]) assert.equal(isBannedClient({ status: s }), isBannedStatus(s), `「${s}」两边说法不一样`);
});

check("U2 下拉选项去掉封禁的、只留唛头（不带名字、不带状态）；封禁名单单独拿", () => {
  const list = [{ id: "A1", name: "甲", status: "active" }, { id: "B2", name: "乙", status: "inactive" }, { id: "C3", name: "丙" }];
  assert.deepEqual(activeMarkOptions(list), [{ id: "A1" }, { id: "C3" }]);
  assert.deepEqual([...bannedClientIds(list)], ["B2"]);
});

check("U2b 提示什么时候出：是封禁的、而且跟原来的不一样才出；去掉首尾空格再认（超管那两个框提交时也去）", () => {
  const banned = new Set(["B2"]);
  assert.equal(bannedChangeHint("B2", "", banned), BANNED_MARK_HINT, "新建时打封禁的");
  assert.equal(bannedChangeHint(" B2 ", null, banned), BANNED_MARK_HINT, "带首尾空格也认");
  assert.equal(bannedChangeHint("B2", "B2", banned), null, "原来就是它（老单照常改）不提示");
  assert.equal(bannedChangeHint("B2", " B2", banned), null);
  assert.equal(bannedChangeHint("A1", "", banned), null, "没封的不提示");
  assert.equal(bannedChangeHint("  ", "", banned), null);
  assert.equal(bannedChangeHint("b2", "", banned), null, "大小写不同算别的唛头（唛头一字不差才算，同 MarkPicker）");
});

check("U2c 原来就挂在封禁唛头名下的单：那个唛头留在下拉里（排第一个），别的封禁的照旧不列；本来就在的不重复", () => {
  const opts = [{ id: "A1" }, { id: "C3" }];
  assert.deepEqual(withCurrentMark(opts, "B2"), [{ id: "B2" }, { id: "A1" }, { id: "C3" }]);
  assert.deepEqual(withCurrentMark(opts, "B2 "), [{ id: "B2 " }, { id: "A1" }, { id: "C3" }], "加进去的是原文（框里的值就是原文，一字不差才算选中）");
  assert.equal(withCurrentMark(opts, "   "), opts);
  assert.equal(withCurrentMark(opts, "A1"), opts, "本来就在选项里：原样返回");
  assert.equal(withCurrentMark(opts, ""), opts);
  assert.equal(withCurrentMark(opts, undefined), opts);
});

check("U3 页面上的提示跟后端拦下时那句一字不差（员工在页面上看到的、被拦时弹出来的是同一句）", () => {
  // 老板 2026-10-17：「提示说账号已封禁」
  assert.equal(BANNED_MARK_HINT, "账号已封禁");
  assert.equal(BANNED_CLIENT_MESSAGE, BANNED_MARK_HINT);
});

check("U4 员工端「创建订单」两个唛头框：选项去掉封禁的（预报单里带出来的唛头也剔），框里打的是封禁的就提示；封禁 / 解封推送来了重拉名单", () => {
  const src = read("apps/web/src/app/staff/page.tsx");
  const opts = src.match(/const allClientOptions = useMemo\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/);
  assert.ok(opts, "allClientOptions 那段找不到");
  assert.match(opts![0], /activeMarkOptions\(staffClients\)/, "客户名单要先去掉封禁的");
  assert.match(opts![0], /bannedClients\.has\(item\.clientId\)/, "预报单带出来的唛头也要剔掉封禁的");
  assert.ok(!/staffClients\.forEach/.test(opts![0]), "不能再把整份客户名单（含封禁的）塞进选项");
  assert.equal((src.match(/options=\{allClientOptions\}/g) ?? []).length, 2, "两个建单框都用这份选项");
  assert.equal((src.match(/bannedChangeHint\(clientSearchKeyword, "", bannedClients\)/g) ?? []).length >= 2, true, "两个框下面都有提示");
  // 超管封禁 / 解封发的是 accounts 推送（topics.ts）：订了它才会重拉名单（Codex 审查）；整页一直订，不按页签开关（Codex 第 2 轮：停在别的页签时漏掉的，切回来不会补拉）
  const sub = src.match(/useLiveRefresh\(\{\s*topics: \["accounts"\],[\s\S]*?\n  \}\);/);
  assert.ok(sub, "没订「账号」推送，页面开着时封禁 / 解封不会反映到下拉");
  assert.ok(!/enabled:/.test(sub![0]), "「账号」推送不能按页签开关");
  assert.match(sub![0], /fetchStaffClients\(\)[\s\S]*clientsGate\.accept/);
  assert.match(src, /if \(clientsGate\.accept\(clientsTicket, null\)\) setStaffClients\(clientItems\);/, "整页重拉那份名单也要过同一个门闩（晚回来的旧名单不盖新的）");
});

check("U5 超管端：「创建订单」唛头框、「运单管理」改唛头框都去掉封禁的（改单时原来那个唛头留着）；改单的提示只在换成封禁的时出", () => {
  const src = read("apps/web/src/app/admin/page.tsx");
  assert.match(src, /<MarkPicker value=\{orderEditForm\.clientId\}[^\n]*options=\{withCurrentMark\(activeMarkOptions\(clientList\), editSnapshot\?\.form\.clientId\)\}/);
  assert.match(src, /bannedChangeHint\(orderEditForm\.clientId, editSnapshot\?\.form\.clientId, bannedClientIds\(clientList\)\)/, "改单提示要拿原来的唛头比");
  // 创建订单用页面上那份 clientList（推送 / 10 秒兜底一直在刷）；原来点开时单拉一份，开着弹窗时别人封了不会变（Codex 第 2 轮）
  assert.match(src, /<MarkPicker value=\{createForm\.clientId\}[^\n]*options=\{activeMarkOptions\(clientList\)\}/);
  assert.match(src, /bannedChangeHint\(createForm\.clientId, "", bannedClientIds\(clientList\)\)/);
  assert.ok(!/staffClients/.test(src), "超管页又出现了单独一份 staffClients（不跟推送刷新）");
  // clientList 的几处拉取过同一个门闩：别的超管刚封的不能被一份晚回来的旧名单放回来
  const load = src.match(/const loadClients = useCallback\(async \(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/);
  assert.ok(load && /clientsGate\.begin\(null\)/.test(load[0]) && /if \(!clientsGate\.accept\(ticket, null\)\) return;/.test(load[0]), "超管页客户名单没过门闩");
  const sub = src.match(/useLiveRefresh\(\{\s*topics: \[[^\]]*"accounts"[^\]]*\],([\s\S]*?)\n  \}\);/);
  assert.ok(sub && /loadClients\(\)/.test(sub[1]), "超管页没订「账号」推送重拉客户名单");
  assert.match(sub![1], /enabled: session !== null,/, "超管页「账号」推送只看登没登录，不能再加别的开关（Codex 第 3 轮）");
  assert.match(src, /setShowCreateOrderModal\(true\);[\s\S]{0,300}?loadClients\(\)\.catch\(/, "点「创建订单」要顺手拉一次名单，失败也不留未处理的报错");
  // 创建订单弹窗里要看得见后端拦下的那句（「创建失败：账号已封禁」）：原来只写在页面最底下、被全屏弹窗挡住（Codex / dsh 第 8 轮）
  const modal = src.slice(src.indexOf("<MarkPicker value={createForm.clientId}"), src.indexOf("{/* 批量导入弹窗 */}"));
  assert.match(modal, /\{message \? \(\s*<p role="alert"[^>]*>\{message\}<\/p>\s*\) : null\}/, "创建订单弹窗里没显示 message");
  assert.match(src, /setShowCreateOrderModal\(true\);\s*\n\s*setMessage\(""\);/, "打开创建订单弹窗要先清掉上一回的提示");
});

check("U6 全站每个唛头下拉点名：挂单的四处都去掉封禁的；整柜询价那个不在这次范围（询价不是单），照旧全给", () => {
  const files = [
    "apps/web/src/app/admin/page.tsx",
    "apps/web/src/app/staff/page.tsx",
    "apps/web/src/components/client/FclInquiryPanel.tsx",
    "apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx",
  ];
  // 先确认没有漏掉的文件：全站用 MarkPicker 的就这四个
  const all: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".tsx") && !p.endsWith("MarkPicker.tsx") && /<MarkPicker\b/.test(fs.readFileSync(p, "utf8"))) all.push(path.relative(process.cwd(), p));
    }
  };
  walk(path.resolve("apps/web/src"));
  assert.deepEqual(all.sort(), [...files].sort(), "新加了唛头下拉：想一下它是不是「挂单」的，是就用 activeMarkOptions，再把这里的名单补上");
  // 挂单的那几个框：选项都得经过「去掉封禁的」那一步（直接去名单或父页面剔过的那份）；整柜询价那个照旧全给
  const optionsOf = (rel: string) => [...read(rel).matchAll(/<MarkPicker\b[\s\S]*?options=\{([^\n]*?)\}\s*(?:loadFailed|placeholder)/g)].map((m) => m[1]);
  for (const o of optionsOf(files[0])) assert.match(o, /activeMarkOptions\(/, `超管页有个唛头下拉没去掉封禁的：${o}`);
  assert.equal(optionsOf(files[0]).length, 2);
  for (const o of optionsOf(files[1])) assert.equal(o, "allClientOptions");
  assert.equal(optionsOf(files[1]).length, 2);
  for (const o of optionsOf(files[3])) assert.match(o, /props\.clients/);
  // 到货通知的 props.clients 是父页面剔过的那份（G4 真跑过；这里再钉一下来源）
  assert.match(read(files[3]), /setClients\(activeMarkOptions\(items\)\)/);
});

check("U7 后端每条挂单路：拦截在、而且排在这条路自己的锁之后、写库之前（锁序最后一环，core/client-ban.ts 文件头；拦不拦、排不排队在 test-client-ban-db.ts 连库测）", () => {
  /** 某个接口的处理函数那一段（从 app.post("路径" 到下一个 app.xxx(）） */
  const handler = (rel: string, route: string) => {
    const src = read(rel);
    const at = src.indexOf(`app.post("${route}"`);
    assert.ok(at >= 0, `${rel} 找不到 ${route}`);
    const next = src.slice(at + 10).search(/\n  app\.(get|post|delete)\(/);
    return next < 0 ? src.slice(at) : src.slice(at, at + 10 + next);
  };
  /** 在 body 里，第 k 个 assertClientNotBanned 排在 after 之后、before 之前 */
  const between = (body: string, label: string, after: RegExp, before: RegExp, k = 0) => {
    const calls = [...body.matchAll(/assertClientNotBanned\(tx, /g)].map((m) => m.index!);
    assert.ok(calls.length > k, `${label}：没接封禁拦截`);
    const a = body.search(after), b = body.slice(calls[k]).search(before);
    assert.ok(a >= 0 && a < calls[k], `${label}：封禁拦截排到了 ${after} 前面（要在这条路自己的锁之后）`);
    assert.ok(b >= 0, `${label}：封禁拦截后面找不到 ${before}（要在写库之前）`);
  };
  const O = "apps/api/src/modules/orders/routes.ts", A = "apps/api/src/modules/admin/routes.ts";
  const N = "apps/api/src/modules/arrival-notices/routes.ts", F = "apps/api/src/modules/fcl-containers/routes.ts";
  between(handler(O, "/staff/orders"), "员工 / 超管建单", /lockTrackingNoForArrivalNotice\(tx, /, /tx\.order\.create\(/);
  between(handler(O, "/client/prealerts"), "客户报预报单", /generatePrealertNo\(tx, /, /tx\.order\.create\(/);
  between(handler(A, "/admin/orders/update"), "超管改单", /lockShipmentsChildrenFirst\(tx, /, /tx\.order\.update\(\{\s*where: \{ id: orderId \}/);
  const save = handler(N, "/staff/arrival-notices/save");
  between(save, "到货通知新登记", /lockTrackingNoForArrivalNotice\(tx, /, /tx\.arrivalNotice\.create\(/, 0);
  between(save, "到货通知修改", /lockLinkedShipment\(tx, n\)/, /syncToPendingShipment\(tx, /, 1);
  between(handler(N, "/staff/arrival-notices/convert"), "到货通知转运单", /lockLinkedShipment\(tx, n\)/, /tx\.order\.create\(/);
  between(handler(F, "/staff/fcl-containers/create"), "建整柜", /lockInquiry\(tx, /, /tx\.order\.create\(/);
  between(handler(F, "/staff/fcl-containers/update"), "改整柜", /FOR UPDATE`;\n\s*\}/, /tx\.order\.update\(/);
  // 封禁那边：独占档、带时限、超时翻成 409
  const ban = handler(A, "/admin/users/toggle-ban");
  // 封禁那边：先「只试不排队」拿独占档，拿到再限时（1 秒，CLIENT_BAN_ROW_WAIT）锁客户行、写 status；带时限，等不到翻成 409（Codex / dsh 第 3～5 轮）
  assert.match(ban, /await lockClientBan\(tx, auth\.companyId, id\);\s*\n\s*await tx\.\$executeRawUnsafe\(`SET LOCAL lock_timeout = '\$\{CLIENT_BAN_ROW_WAIT\}'`\);\s*\n\s*await tx\.\$queryRaw`SELECT id FROM users WHERE id = \$\{id\} FOR NO KEY UPDATE`;\s*\n\s*await tx\.user\.update\(/, "封禁接口要先试拿锁、再限时锁客户行、再写");
  assert.match(ban, /55P03/, "等客户行超时（55P03）要翻成 409");
  assert.match(ban, /\}, CLIENT_BAN_TX\);/, "封禁事务没设时限（Prisma 默认 5 秒就 500）");
  // 两档锁的写法钉死：挂单共享档（挂单之间不互等）、封禁只试不排队（不挡后来的挂单）
  const core = read("apps/api/src/modules/core/client-ban.ts");
  const fn = (name: string) => core.slice(core.indexOf(`export async function ${name}`), core.indexOf("\n}\n", core.indexOf(`export async function ${name}`)));
  assert.match(fn("assertClientNotBanned"), /pg_advisory_xact_lock_shared\(83070,/, "挂单那边要拿共享档");
  assert.match(fn("lockClientBan"), /pg_try_advisory_xact_lock\(83070,/, "封禁那边要「只试不排队」");
  assert.ok(!/SELECT pg_advisory_xact_lock\(83070/.test(core), "不许出现会排队的独占档（排上队就挡住后来的挂单）");
  // 等客户行的上限钉死 1 秒（拿着独占等，后来的挂单跟着等；挂单可能已经在前面的锁上花了几秒，事务默认 5 秒 —— Codex / dsh 第 5、6 轮）
  assert.equal(CLIENT_BAN_ROW_WAIT, "1s");
  assert.equal(CLIENT_BAN_WAIT_MS, 10000);
});

if (failures > 0) { console.log(`\n${failures} 项没过`); process.exit(1); }
console.log("\n封禁唛头不进挂单下拉（不连库）全部通过");
