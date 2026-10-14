/**
 * 装柜管理页面：操作失败时红字报错不能被刷新冲掉（2026-09-17，Opus 第 6 轮复核 B 报的）。
 *
 * 页面里 loadList / loadShipmentList 一进门（非静默时）就 setError("")（清掉上一次的报错；loadDetail 清的是 detailError，不清它）。
 * 撤销、删除这两个 handler 失败时「先 setError 再刷新」，结果报错一闪就没了 ——
 * 员工点了撤销没反应、也不知道为什么（后端这时候会说「刚刚被别人改过，请刷新后再看」这种要紧的话）。
 * 所以这两处必须**先刷新、最后 setError**。
 *
 * 不连数据库、不起服务，直接读页面源码卡住写法。用法：npm run test:container-page
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beijingLocalToMs, beijingNowMinute } from "../apps/web/src/modules/shared/beijing-date";
import { isFutureStatusTime, parseStatusTime } from "../apps/api/src/modules/containers/status-time";
import { checkPushTime } from "../apps/web/src/modules/staff/container-push-time";

const file = path.join(process.cwd(), "apps/web/src/app/staff/container-loading/page.tsx");
const source = readFileSync(file, "utf-8");

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${name}\n     ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

/** 取某个 handler 里 catch 块的代码 */
function catchBlockOf(handler: string): string {
  const start = source.indexOf(`const ${handler} = async`);
  assert.ok(start >= 0, `找不到 ${handler}`);
  const next = source.indexOf("\n  const ", start + 10);
  const body = source.slice(start, next > 0 ? next : source.length);
  // 取最后一个 catch：撤销那个 handler 前面还有一个「查撤销预览失败」的 catch（那处没有刷新）
  const c = body.lastIndexOf("} catch (e) {");
  assert.ok(c >= 0, `${handler} 里没有 catch`);
  return body.slice(c);
}

console.log("装柜管理页面：失败提示不能被刷新冲掉");

check("刷新列表一进门就清报错（下面两条的前提）", () => {
  const at = source.indexOf("const loadList = useCallback");
  assert.ok(at >= 0, "找不到 loadList");
  assert.ok(source.slice(at, at + 400).includes('setError("")'), "loadList 里没有 setError(\"\")，这份测试的前提变了，去改测试");
});

for (const [handler, zh] of [["handleUndoStatus", "撤销"], ["handleDelete", "删除柜子"]] as const) {
  check(`${zh}失败：先刷新、最后才 setError（报错才留得住）`, () => {
    const block = catchBlockOf(handler);
    const err = block.indexOf("setError(");
    assert.ok(err >= 0, `${handler} 的 catch 里没有 setError`);
    const refreshes = [...block.matchAll(/await\s+loadList\(/g)].map((m) => m.index ?? -1);
    assert.ok(refreshes.length > 0, `${handler} 的 catch 里没有刷新列表`);
    const late = refreshes.filter((i) => i > err);
    assert.deepEqual(
      late.map((i) => block.slice(i, i + 40).split("(")[0].trim()),
      [],
      `${handler} 失败后还有刷新排在 setError 后面，报错会被清掉`,
    );
  });
}

for (const [handler, zh] of [["handleUndoStatus", "撤销"], ["handleDelete", "删除柜子"]] as const) {
  check(`${zh}失败：刷新自己再出错也要把报错显示出来（刷新放在 try 里、setError 放 finally）`, () => {
    const block = catchBlockOf(handler);
    const fin = block.indexOf("} finally {");
    assert.ok(fin >= 0, `${handler} 的 catch 里没有 finally：刷新自己抛错时报错会丢`);
    const err = block.indexOf("setError(");
    assert.ok(err > fin, `${handler} 的 setError 不在 finally 里`);
    const refreshes = [...block.matchAll(/await\s+(loadList|loadDetail|loadShipmentList)\(/g)].map((m) => m.index ?? -1);
    assert.deepEqual(refreshes.filter((i) => i > fin), [], `${handler} 的 finally 里还有刷新，抛错照样会漏掉 setError`);
  });
}

check("撤销失败时不是笼统一句「撤销失败」盖掉后端的话", () => {
  const block = catchBlockOf("handleUndoStatus");
  assert.match(block, /e instanceof Error \? e\.message/, "撤销失败没有把后端说的原话显示出来");
});

// ---------------- 改状态填时间（2026-10-14 老板：「装柜管理那里修改状态的时候，加个时间吧。默认状态的时间是现在，也可以去改时间」） ----------------
console.log("\n装柜管理页面：改状态的「时间」");

const pushBlock = (() => {
  const start = source.indexOf("const handlePushStatus = async");
  assert.ok(start >= 0, "找不到 handlePushStatus");
  return source.slice(start, source.indexOf("\n  const ", start + 10));
})();

check("时间框带「时间」两个字、能选到分钟（datetime-local），没改过就显示「现在」", () => {
  assert.match(source, /时间\(北京\)\s*<input\s+type="datetime-local"/, "时间框前面没有「时间(北京)」字样，或不是能选时分的框");
  assert.match(source, /value=\{statusTime \|\| nowShown\}/, "时间框没改过时不是显示「现在」");
  assert.doesNotMatch(source, /type="date"/, "还留着原来只有年月日、没写字的日期框");
});

check("时间框某一段被退格清掉（浏览器给空串）时不跳回「现在」，留着上一次完整的时间", () => {
  assert.match(source, /onChange=\{\(e\) => \{ if \(e\.target\.value\) \{ bumpDraft\(\); setStatusTime\(e\.target\.value\); \} \}\}/,
    "空串也存进去了：先改了日、再在月上按退格，日会被冲回今天，推上去是错的日子");
});

check("没改过时间就不发（后端用服务器的当前时间），改过才发员工填的", () => {
  assert.match(pushBlock, /const sent = \{ remark: statusRemark, time: statusTime, nextStop \};/, "推的时候没记下员工改过的时间");
  assert.match(pushBlock, /date: sent\.time \|\| undefined/, "推状态时发的不是员工改过的时间");
  assert.doesNotMatch(pushBlock, /date: [^,}]*nowShown/, "把页面上显示的「现在」发出去了 —— 页面开着放久了就不是现在了");
});

check("推之前用 checkPushTime 判断（没填完整 / 将来先拦，比上一步早先问），检查之前不清目标状态", () => {
  assert.match(pushBlock, /checkPushTime\(statusTime, detail\.statusChangedAt\)/, "没用共用的判断，或没把上一步的时间传进去");
  for (const kind of ["incomplete", "future"]) {
    assert.match(pushBlock, new RegExp(`timeCheck\\.kind === "${kind}"\\) \\{ pushError\\(pushId, [^)]*\\); return; \\}`), `「${kind}」没拦下，或没记成推进自己的报错`);
  }
  assert.match(pushBlock, /timeCheck\.kind === "earlier"\) \{\s*const ok = window\.confirm\([\s\S]*?if \(!ok\) return;/, "比上一步早没先问，或问了不管答案");
  const check = pushBlock.indexOf("checkPushTime(");
  const clear = pushBlock.indexOf("setTargetStatus(");
  assert.ok(check >= 0 && clear > check, "目标状态在检查之前就清了（被拦下或取消时选好的状态得留着）");
  const buttonLine = source.split("\n").find((line) => /onClick=\{.*handlePushStatus\(targetStatus\)/.test(line));
  assert.ok(buttonLine, "找不到「确认推进」按钮的 onClick");
  assert.doesNotMatch(buttonLine, /setTargetStatus\(/, "按钮上又直接清目标状态了：被拦下或点取消，员工得重选状态");
});

check("判断规矩真跑：改过的时间严格比上一步；没改时只在上一步明显记在将来（10 分钟以上）才问，不怕员工电脑慢几分钟", () => {
  const now = Date.UTC(2026, 9, 14, 8, 0); // 北京 10-14 16:00
  const iso = (bj: string) => new Date(Date.UTC(+bj.slice(0, 4), +bj.slice(5, 7) - 1, +bj.slice(8, 10), +bj.slice(11, 13) - 8, +bj.slice(14, 16))).toISOString();
  const prev = iso("2026-10-13T10:00");
  assert.equal(checkPushTime("2026-10-13T09:59", prev, now).kind, "earlier", "改成比上一步早 1 分钟没问");
  assert.equal(checkPushTime("2026-10-13T10:00", prev, now).kind, "ok", "跟上一步同一分钟不该问");
  assert.equal(checkPushTime("2026-10-13T15:30", prev, now).kind, "ok");
  assert.equal(checkPushTime("", prev, now).kind, "ok", "没改、上一步在过去，不该问");
  assert.equal(checkPushTime("", iso("2026-10-14T16:05"), now).kind, "ok", "上一步只比现在晚 5 分钟（电脑时钟差）不该问");
  const legacy = checkPushTime("", iso("2026-10-15T08:00"), now);
  assert.equal(legacy.kind, "earlier", "上一步记在将来（旧页面只给日期记成北京 8 点 / 10-30 那种），没改直接推没问");
  if (legacy.kind === "earlier") assert.deepEqual([legacy.atMs, Date.parse(iso("2026-10-15T08:00"))], [now, legacy.prevMs]);
  assert.equal(checkPushTime("2026-10-14T16:09", prev, now).kind, "ok", "晚 9 分钟（时钟快一点）不该拦");
  assert.equal(checkPushTime("2026-10-14T16:11", prev, now).kind, "future", "晚 11 分钟该拦");
  assert.equal(checkPushTime("2026-10-13T09:00", null, now).kind, "ok", "老柜子没有上一步的时间，不比");
  assert.equal(checkPushTime("2026-02-30T10:00", prev, now).kind, "incomplete", "2 月 30 日没拦");
  assert.equal(checkPushTime("2026-10-13T15:30:45", prev, now).kind, "ok", "浏览器给带秒的值也要认");
});

check("推进：按柜记「推进中」防连点；请求一落地就放开；刷新静默不等；推成功且还在这个柜才清、只清推的时候那一份；失败马上报、换了柜改弹提示；带上页面看到的状态", () => {
  const send = pushBlock.indexOf("await updateContainerStatus(");
  assert.ok(send >= 0, "找不到发请求那句");
  assert.match(pushBlock, /const pushId = selectedId;\s*if \(pushingRef\.current\.has\(pushId\)\) return;/, "同一个柜推进中再点没挡");
  const add = pushBlock.indexOf("pushingRef.current.add(pushId)");
  assert.ok(add >= 0 && add < send, "发请求前没标这个柜「推进中」");
  const release = pushBlock.search(/\} finally \{\s*pushingRef\.current\.delete\(pushId\);/);
  assert.ok(release > send, "请求落地后没放开「推进中」");
  assert.match(pushBlock, /const fromStatus = detail\.status;/, "没记下推之前页面看到的状态");
  assert.match(pushBlock, /expectStatus: fromStatus/, "没带页面看到的柜子状态（超时后再点一次会多写一条）");
  assert.match(pushBlock, /if \(result\) \{\s*if \(stillHere\) \{[\s\S]{0,120}?const own = pushErrorRef\.current;\s*if \(own && own\.containerId === pushId\) \{\s*setError\(\(cur\) => \(cur === own\.message \? "" : cur\)\);\s*pushErrorRef\.current = null;[^\n]*\n\s*\}/,
    "推成功没清上一次推失败的红字，或连别的操作的报错一起清了，或没认柜子");
  assert.match(pushBlock, /\} else if \(stillHere\) \{\s*pushError\(pushId, failure\);/, "推失败没记下是推进自己写的报错");
  // 推进里所有的报错都走 pushError（记下哪个柜、什么话），推成功才清得掉（Codex / dsh 第 8 轮：当场拦下的两条原来没记）
  assert.equal((pushBlock.match(/pushError\(/g) ?? []).length, 3, "推进里该有 3 处走 pushError：没填完整、将来、请求失败");
  assert.equal((pushBlock.match(/\bsetError\(/g) ?? []).length, 1, "推进里绕开 pushError 直接写了报错（推成功清不掉）");
  assert.match(source, /const pushError = \(containerId: string, message: string\) => \{\s*pushErrorRef\.current = \{ containerId, message \};\s*setError\(message\);/, "pushError 没同时记下柜子和那句话");
  // 清输入看「员工亲手改过几次」，不按值比（Codex 第 7 轮：实时刷新先清掉目标状态，按值比会误判成员工改过，备注、时间留在框里）
  assert.match(pushBlock, /const editsAtSend = draftEditsRef\.current;/, "发请求时没记下员工改过几次");
  assert.match(pushBlock, /if \(draftEditsRef\.current === editsAtSend\) \{\s*setTargetStatus\(""\);\s*setStatusRemark\(""\);\s*setNextStop\(""\);\s*setStatusTime\(""\);/,
    "推成功清输入不是看员工有没有亲手改过");
  for (const [re, where] of [
    [/onChange=\{\(e\) => \{ bumpDraft\(\); setStatusRemark\(e\.target\.value\); \}\}/, "备注"],
    [/onChange=\{\(e\) => \{ bumpDraft\(\); setNextStop\(e\.target\.value\); \}\}/, "下一站"],
    [/onChange=\{\(e\) => \{ if \(e\.target\.value\) \{ bumpDraft\(\); setStatusTime\(e\.target\.value\); \} \}\}/, "时间"],
    [/onClick=\{\(\) => \{ bumpDraft\(\); setStatusTime\(""\); refreshNow\(\); \}\}/, "改回现在"],
    [/bumpDraft\(\);\s*setTargetStatus\(e\.target\.value\);/, "选目标状态"],
  ] as const) assert.match(source, re, `员工改${where}没记一次「亲手改过」`);
  assert.equal((source.match(/bumpDraft\(\)/g) ?? []).length, 5, "「亲手改过」只该在员工动手的 5 个地方记（程序自己清的不算）");
  assert.match(source, /detailRevRef\.current \+= 1;\s*setDetail\(d\);/, "详情加载落地没记次数");
  assert.match(pushBlock, /const detailRevAtSend = detailRevRef\.current;/, "发请求时没记下详情的次数");
  assert.match(pushBlock, /if \(detailRevRef\.current === detailRevAtSend\) \{\s*setDetail\(\(cur\) => \(cur && cur\.id === pushId && cur\.status === fromStatus \? \{ \.\.\.cur, status: toStatus, statusChangedAt: updatedAt \} : cur\)\);/,
    "推成功先改页面状态没核对这期间详情有没有被刷新过（状态绕回来会改错），或没认原来的状态");
  assert.doesNotMatch(pushBlock, /new Date\(\)\.toISOString\(\)/, "又拿本机时间当这一步的时间了（应该用后端返回的 updatedAt）");
  assert.equal((pushBlock.match(/setTargetStatus\(/g) ?? []).length, 1, "推进里别处又清了目标状态（推失败也得重选）");
  assert.ok(pushBlock.indexOf("setTargetStatus(") > pushBlock.indexOf("if (result) {"), "目标状态不是推成功才清");
  assert.match(pushBlock, /\} else if \(stillHere\) \{\s*pushError\(pushId, failure\);/, "失败没马上报");
  assert.match(pushBlock, /\} else \{\s*setToast\(`柜子「\$\{pushNo\}」没推成：\$\{failure\}`\);/, "换了柜之后旧柜失败一点反馈都没有");
  assert.match(pushBlock, /void loadList\(\{ silent: true \}\);\s*if \(selectedIdRef\.current === pushId\) void loadDetail\(pushId, \{ silent: true \}\);/, "推完的刷新不是静默不等（非静默会清备注、清报错，卡住还压着）");
  assert.match(source, /if \(detail && targetStatus && !pushOptions\.includes\(targetStatus\)\) \{\s*setTargetStatus\(""\);/, "目标状态作废只藏起来没清（以后撤销回去旧选择会冒出来）");
  assert.match(source, /const targetOk = options\.includes\(targetStatus\);/, "没核对选好的目标状态还在不在可选里");
  assert.match(source, /const busy = pushingIds\.includes\(detail\.id\);/, "「推进中」不是按柜算的");
  assert.match(source, /disabled=\{!targetOk \|\| busy\}/, "推进中 / 目标状态作废时按钮没变灰");
  const api = readFileSync(path.join(process.cwd(), "apps/web/src/services/business-api.ts"), "utf-8");
  const fn = api.slice(api.indexOf("export async function updateContainerStatus("), api.indexOf("export async function", api.indexOf("export async function updateContainerStatus(") + 10));
  assert.match(fn, /return apiRequest\(/, "推柜子状态没走 apiRequest（没有超时，网络卡住按钮会一直「推进中…」）");
});

check("「现在」和最晚可选时间一起刷（refreshNow），每个该刷的地方都调它；框有焦点时只走最晚可选时间", () => {
  assert.match(source, /const refreshNow = useCallback\(\(\) => \{\s*const now = beijingNowMinute\(\);\s*setNowShown\(now\);\s*setMaxNow\(now\);/, "refreshNow 没把两个一起刷");
  assert.equal((source.match(/setNowShown\(/g) ?? []).length, 1, "别处单独刷了「现在」，跟最晚可选时间会对不上");
  const sites: Array<[RegExp, string]> = [
    [/onFocus=\{refreshNow\}/, "点进时间框"],
    [/onBlur=\{refreshNow\}/, "离开时间框"],
    [/setStatusTime\(""\);\s*refreshNow\(\);\s*setError\(""\);[^\n]*\n\s*pushErrorRef\.current = null;\s*\}, \[selectedId, refreshNow\]\);/, "换柜子"],
    [/onClick=\{\(\) => \{ bumpDraft\(\); setStatusTime\(""\); refreshNow\(\); \}\}/, "改回现在"],
    [/setNextStop\(nextStopDefault\(e\.target\.value, detail\.transportMode\)\);\s*refreshNow\(\);/, "选目标状态"],
    [/const tick = \(\) => \{ if \(document\.activeElement === timeInputRef\.current\) setMaxNow\(beijingNowMinute\(\)\); else refreshNow\(\); \};/, "每 30 秒（有焦点只走最晚可选时间）"],
    [/addEventListener\("visibilitychange", onVisible\)/, "标签页切回来"],
  ];
  for (const [re, where] of sites) assert.match(source, re, `${where}没调 refreshNow（或写法变了）`);
  assert.match(pushBlock, /setStatusTime\(""\);\s*\}\s*refreshNow\(\);/, "推成功后没调 refreshNow");
});

check("换柜子、推完一次都把时间清回「现在」（别把上一个柜填的时间带到下一个柜）", () => {
  const from = source.indexOf("useEffect(() => {\n    setTargetStatus(\"\");");
  const to = source.indexOf("}, [selectedId, refreshNow]);");
  assert.ok(from >= 0 && to > from, "找不到「换柜子清输入」那个 effect（写法变了就来改测试，别让这条空过）");
  const effect = source.slice(from, to);
  assert.match(effect, /setStatusTime\(""\)/, "换柜子没清时间");
  assert.match(pushBlock, /setStatusTime\(""\);/, "推完没清时间");
  assert.match(effect, /setError\(""\);/, "换柜子没清上一个柜的报错");
});

check("北京时间换算：页面和后端各一份，对同一个时间要换出同一个时刻", () => {
  assert.equal(beijingNowMinute(Date.UTC(2026, 9, 13, 16, 30, 59)), "2026-10-14T00:30", "UTC 10-13 16:30 应该是北京 10-14 00:30");
  for (const text of ["2026-10-14T00:30", "2026-12-31T23:59", "2026-03-01T08:00"]) {
    const ms = beijingLocalToMs(text);
    const parsed = parseStatusTime(text);
    assert.ok(ms !== null && parsed, `「${text}」有一边认不出`);
    assert.equal(parsed.at.getTime(), ms, `「${text}」两边换出来不一样`);
    assert.equal(beijingNowMinute(ms), text, `「${text}」换过去再换回来对不上`);
  }
  for (const bad of ["2026-10-14", "2026-10-14 10:00", "abc", "2026-02-30T10:00", "2026-10-14T24:00", "2026-10-14T10:60"]) assert.equal(beijingLocalToMs(bad), null, `页面认了「${bad}」`);
  assert.equal(beijingLocalToMs("2026-10-14T00:30:59"), beijingLocalToMs("2026-10-14T00:30"), "页面带秒的值没把秒丢掉");
  assert.equal(parseStatusTime("2026-10-14T00:30:59")?.at.getTime(), beijingLocalToMs("2026-10-14T00:30"), "后端带秒的值没把秒丢掉");
  for (const bad of ["2026-02-30T10:00", "2026-10-14T24:00", "2026-10-14T10:60", "2026/10/14", "abc"]) {
    assert.equal(parseStatusTime(bad), null, `后端认了「${bad}」`);
  }
});

check("填成将来：带时分的留 10 分钟余量；只给日期的按北京日期比", () => {
  const now = Date.UTC(2026, 9, 14, 7, 0); // 北京 10-14 15:00
  const p = (t: string) => { const r = parseStatusTime(t); assert.ok(r, `认不出「${t}」`); return r; };
  assert.equal(isFutureStatusTime(p("2026-10-14T15:09"), now), false, "晚 9 分钟（电脑时钟快一点）不该拦");
  assert.equal(isFutureStatusTime(p("2026-10-14T15:11"), now), true, "晚 11 分钟该拦");
  assert.equal(isFutureStatusTime(p("2026-10-14"), Date.UTC(2026, 9, 13, 17, 0)), false, "北京 10-14 凌晨 1 点选「10-14」不该拦");
  assert.equal(isFutureStatusTime(p("2026-10-15"), now), true, "明天的日期该拦");
});

console.log(`\nCHECKS ${failures === 0 ? "全过" : `失败 ${failures} 项`}`);
if (failures > 0) process.exitCode = 1;
