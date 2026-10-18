/**
 * 2026-10-18 晚 老板「小问题也修一下吧」—— 源码那一半（不连库）。清单：.audit/2026-10-18/small-fixes/plan.md。
 *
 *   F1  「写成功、刷新失败报成写失败」全前端扫一遍（#19）：一个 try 里先写（建 / 改 / 删）、后刷新（load / reload / refresh / fetch 开头的），
 *       catch 里说「失败」的 —— 那个刷新函数自己必须接住报错（整个函数体包在 try 里、catch 不往外抛），
 *       或者只等 Promise.allSettled（不会抛）。不然刷新失败就落进写的 catch，员工看到「保存失败」再点一次，又写一遍。
 *       扫描本身至少要找到 30 处候选（防止扫描写坏了、一处都没扫到也算过）。
 *   F2  这一批补的列表门闩（#26）：从「领号」到「把列表写上屏幕」中间必须先过门闩（accept / isCurrent 没过就 return），
 *       列表用的门闩必须是「成功才作废」那种（createQueryGate，request-gate.ts 用法三）
 *   F3  客户首页运单列表：后台刷新先问让不让路、再领号（领了号就把客户点的那次作废了）；客户点的两条路都登记、都在收尾时注销；
 *       补发那次填了筛选条件就不发（#26 D-P2-7）
 *   F4  员工集货详情：先认主人再领号（不是当前选中的任务不拉）（#26 F-11）
 *   F5  整柜询价「接受」以后按现在的页码重拉（#26 F-18）；集货余额页：三样都刷上了才清掉旧的「没加载出来」（#26 F-19）
 *   F6  员工页刷新被更晚的那次盖过时，给调用方的是屏幕上那份新的（拿来重建草稿的不能是旧的）
 *   F7  员工页「订单详情」：到仓日期当 shipDate 发（#16），「发货时间」「到仓日期」两格联动
 *   F8  产品图三个入口都先用 photoTypeIssue 挡格式（#21）；后端跟到货通知用同一份白名单
 *   F9  客户改密码：页面只对员工 / 管理员 / 代理卡 8 位（#24）
 *   F10 尾端派送候选（普通和整柜共用 toLastmileCandidate，#22）：真跑那个函数 —— 品名带全部产品名（按第二个产品名也搜得到）、
 *       收货人 / 电话 / 地址从后端的 *Th 字段取（原来整柜那边直接强转，字段名对不上读不到）；两个取数函数都走它
 *   F11 客户批量下单重传同一个文件（X2，10-18 浏览器实测后补完整）：真跑上传那段 —— 上一批没收尾干净时，那一批已经建好的行不再交、
 *       提示说清是第几行；没确认的行用回原来的编号；其余行新编号；全部建好过的说「不用再交」；收尾干净的文件照旧全当新单；
 *       换了文件（改过 / 另存过）跟已建好的那行一模一样的标出来、记下来（提交前再问）；别的客户的记号用不上（审查第 1 轮）
 *   F12 真跑提交那段：有「跟已建好的一模一样」的行，点「取消」一张都不交、点「确定」照常交；一批有明确失败的，建好的行留着记号
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import vm from "node:vm";
import { productNamesLabel } from "../packages/shared-types/product-names";

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps/web/src");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e: any) { failed++; console.log(`❌ ${name}\n   ${String(e?.message ?? e).split("\n").join("\n   ")}`); }
}

// ---------------------------------------------------------------------------
// F1 刷新失败报成写失败
// ---------------------------------------------------------------------------
const isRefreshName = (name: string) => /^(load|reload|refresh|fetch)/i.test(name);
const calleeName = (e: ts.Expression): string => ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "";
const sfCache = new Map<string, ts.SourceFile>();
function sourceOf(file: string): ts.SourceFile {
  let sf = sfCache.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    sfCache.set(file, sf);
  }
  return sf;
}
function webFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f)) out.push(p);
    }
  };
  walk(WEB);
  return out;
}
type Candidate = { file: string; line: number; write: string; refresh: string; at: ts.Node };
/** 一个 try 里先 await 写、后 await 刷新，catch 里说失败的 */
function scanCandidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const file of webFiles()) {
    const sf = sourceOf(file);
    const visit = (n: ts.Node) => {
      if (ts.isTryStatement(n) && n.catchClause) {
        const awaits: string[] = [];
        const collect = (m: ts.Node) => {
          if (ts.isFunctionLike(m)) return; // 不进嵌套函数
          if (ts.isTryStatement(m) && m !== n) return; // 嵌套的 try 自己算
          if (ts.isAwaitExpression(m) && ts.isCallExpression(m.expression)) awaits.push(calleeName(m.expression.expression));
          m.forEachChild(collect);
        };
        n.tryBlock.forEachChild(collect);
        const firstWrite = awaits.findIndex((a) => a && !isRefreshName(a));
        const laterRefresh = firstWrite >= 0 ? awaits.slice(firstWrite + 1).find(isRefreshName) : undefined;
        if (laterRefresh && /失败|setError|setToast\(e|setToast\(err|setMessage\(/.test(n.catchClause.block.getText())) {
          out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, write: awaits[firstWrite], refresh: laterRefresh, at: n });
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return out;
}
function findFunction(sf: ts.SourceFile, name: string): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) found = n.initializer;
    n.forEachChild(visit);
  };
  visit(sf);
  return found;
}
function bodyOf(n: ts.Node): ts.Block | null {
  if (ts.isCallExpression(n)) { const a = n.arguments[0]; return a ? bodyOf(a) : null; } // useCallback(async () => {...})
  if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) && n.body && ts.isBlock(n.body)) return n.body;
  return null;
}
/** 从这个 try 往外一层层找最近的同名声明（审查第 1 轮 dsh：原来取文件里第一个同名函数，同一个文件里有好几个 load 就可能看错） */
function findFunctionInScope(from: ts.Node, name: string): ts.Node | null {
  for (let cur: ts.Node | undefined = from.parent; cur; cur = cur.parent) {
    const stmts = ts.isBlock(cur) || ts.isSourceFile(cur) ? cur.statements : null;
    if (!stmts) continue;
    for (const st of stmts) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
      }
    }
  }
  return null;
}
/** 刷新函数自己会不会把报错往外抛：整个函数体的 await 都在不 rethrow 的 try 里，或者只等 Promise.allSettled，才算不抛 */
function refreshMayThrow(c: Candidate): string | null {
  const fn = findFunctionInScope(c.at, c.refresh) ?? findFunction(sourceOf(c.file), c.refresh);
  if (!fn) return "刷新函数不在本文件（多半是直接请求接口 → 会抛）";
  const body = bodyOf(fn);
  if (!body) return "看不出刷新函数的函数体";
  const tries = body.statements.filter(ts.isTryStatement);
  if (tries.some((t) => t.catchClause && /\bthrow\b/.test(t.catchClause.block.getText()))) return "catch 里又抛出去了";
  const outside = body.statements.filter((s) => !ts.isTryStatement(s) && /\bawait\b/.test(s.getText()));
  const onlySettled = outside.every((s) => {
    const awaitsIn = s.getText().match(/\bawait\s+[\w.]+/g) ?? [];
    return awaitsIn.every((a) => /^await\s+Promise\.allSettled$/.test(a));
  });
  if (outside.length && !onlySettled) return "有 await 不在 try 里";
  return null;
}

/** 另外两种写法（审查第 1 轮：F1 只看 try 里直接 await 的）：① 写().then(→ 刷新).catch(说失败) ② try 的 finally 里 await 刷新 —— 现在一处都没有，以后也别出现 */
function otherRiskyShapes(): string[] {
  const out: string[] = [];
  for (const file of webFiles()) {
    const sf = sourceOf(file);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "catch") {
        const inner = n.expression.expression;
        if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === "then") {
          const head = inner.expression.expression;
          const headName = ts.isCallExpression(head) ? calleeName(head.expression) : "";
          if (headName && !isRefreshName(headName) && /\b(load|reload|refresh|fetch)\w*\(/i.test(inner.arguments[0]?.getText(sf) ?? "")
            && /失败|setError|setMessage/.test(n.arguments[0]?.getText(sf) ?? "")) {
            out.push(`${path.relative(WEB, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${headName}().then(刷新).catch(说失败)`);
          }
        }
      }
      if (ts.isTryStatement(n) && n.finallyBlock && /\bawait\s+(load|reload|refresh|fetch)\w*\(/i.test(n.finallyBlock.getText(sf))) {
        out.push(`${path.relative(WEB, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} finally 里 await 刷新`);
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return out;
}

check("F1b 「写().then(刷新).catch(说失败)」和「finally 里 await 刷新」这两种写法全前端一处都没有", () => {
  assert.deepEqual(otherRiskyShapes(), []);
});

check("F1 写成功、刷新失败不会报成「保存 / 删除失败」：全前端「先写后刷新、catch 说失败」的地方，刷新函数都自己接住报错", () => {
  const cands = scanCandidates();
  assert.ok(cands.length >= 30, `扫描只找到 ${cands.length} 处候选，扫描本身可能写坏了`);
  const bad = cands.flatMap((c) => {
    const why = refreshMayThrow(c);
    return why ? [`${path.relative(WEB, c.file)}:${c.line} 写=${c.write} 刷=${c.refresh}：${why}`] : [];
  });
  assert.deepEqual(bad, [], `这些地方刷新失败会落进写的 catch、报成「失败」：\n${bad.join("\n")}`);
});

// ---------------------------------------------------------------------------
// F2 列表门闩
// ---------------------------------------------------------------------------
type GateSite = { file: string; gate: string; setter: string; kind: "query" | "request"; minSites?: number };
const GATES: GateSite[] = [
  { file: "apps/web/src/app/admin/page.tsx", gate: "lmShipmentsGate", setter: "setLmShipments", kind: "query" },
  { file: "apps/web/src/app/admin/page.tsx", gate: "lmOrdersGate", setter: "setLmOrders", kind: "query" },
  { file: "apps/web/src/app/staff/page.tsx", gate: "pageListGate", setter: "setShipments", kind: "query" },
  { file: "apps/web/src/app/staff/page.tsx", gate: "lmShipmentsGate", setter: "setLmShipments", kind: "query" },
  { file: "apps/web/src/app/staff/page.tsx", gate: "lmOrdersGate", setter: "setLmOrderList", kind: "query" },
  { file: "apps/web/src/app/client/address-book/page.tsx", gate: "listGate", setter: "setItems", kind: "query" },
  { file: "apps/web/src/app/client/consolidation/page.tsx", gate: "balanceGate", setter: "setBalance", kind: "query" },
  { file: "apps/web/src/app/client/consolidation/page.tsx", gate: "tasksGate", setter: "setTasks", kind: "query" },
  { file: "apps/web/src/app/client/whr-consolidation/page.tsx", gate: "balanceGate", setter: "setBalance", kind: "query" },
  { file: "apps/web/src/app/client/whr-consolidation/page.tsx", gate: "plansGate", setter: "setPlans", kind: "query" },
  { file: "apps/web/src/app/client/fcl-containers/page.tsx", gate: "listGate", setter: "setRows", kind: "query" },
  { file: "apps/web/src/app/staff/chat/page.tsx", gate: "gate", setter: "setItems", kind: "query" },
  { file: "apps/web/src/components/admin/agents/AgentRebatesPanel.tsx", gate: "listGate", setter: "setItems", kind: "query", minSites: 2 },
  { file: "apps/web/src/components/admin/agents/AgentRebatesPanel.tsx", gate: "detailGate", setter: "setDetail", kind: "request", minSites: 2 },
  { file: "apps/web/src/components/fcl/FclContainerWorkbench.tsx", gate: "lmOrdersGate", setter: "setLmOrders", kind: "query" },
  { file: "apps/web/src/components/fcl/FclContainerWorkbench.tsx", gate: "lmShipmentsGate", setter: "setLmShipments", kind: "query" },
  { file: "apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx", gate: "gate", setter: "setData", kind: "query" },
  { file: "apps/web/src/app/client/page.tsx", gate: "dashboardOrdersGate", setter: "setDashboardOrders", kind: "query", minSites: 2 },
];
for (const g of GATES) {
  check(`F2 ${g.file.replace("apps/web/src/", "")}：${g.gate} 领号以后、${g.setter} 写上屏幕之前先过门闩${g.kind === "query" ? "（成功才作废那种）" : ""}`, () => {
    const src = read(g.file);
    const made = new RegExp(`const ${g.gate} = useRef\\((${g.kind === "query" ? "createQueryGate" : "createRequestGate"})\\b`);
    assert.ok(made.test(src), `${g.gate} 不是用 ${g.kind === "query" ? "createQueryGate" : "createRequestGate"} 建的`);
    const begins = [...src.matchAll(new RegExp(`\\b${g.gate}\\.begin\\(`, "g"))].map((m) => m.index!);
    assert.ok(begins.length >= (g.minSites ?? 1), `${g.gate}.begin 只有 ${begins.length} 处`);
    for (const at of begins) {
      const setAt = src.indexOf(`${g.setter}(`, at);
      assert.ok(setAt > at, `${g.gate}.begin 后面找不到 ${g.setter}`);
      const between = src.slice(at, setAt);
      assert.ok(new RegExp(`${g.gate}\\.(accept|isCurrent)\\(`).test(between),
        `${g.gate} 领号以后没过门闩就写了 ${g.setter}：\n${between.slice(0, 400)}`);
    }
  });
}

/* F2b 反过来查（审查第 1 轮：只查「begin 后面第一个 setter」，同一份数据别处还有写入口就漏了 —— 客户首页 dashboardOrders 就是这么漏的）：
   文件里每一处调这个 setter 的地方，所在函数里都要先领号、再过门闩；只放过清空（[] / null / "" / undefined）和基于原值改（传函数）的 */
function setterCallsWithoutGate(g: GateSite): string[] {
  const sf = ts.createSourceFile(g.file, read(g.file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bad: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === g.setter) {
      const arg = n.arguments[0];
      const isReset = !arg || arg.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(arg) && arg.text === "undefined")
        || (ts.isArrayLiteralExpression(arg) && arg.elements.length === 0) || ts.isStringLiteral(arg) && arg.text === "";
      const isUpdater = !!arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      if (!isReset && !isUpdater) {
        let fn: ts.Node | undefined = n.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        // 回调（.then / .finally 里）往外找到领号的那一层
        let ok = false;
        for (let cur: ts.Node | undefined = fn; cur && !ok; cur = cur.parent) {
          if (!ts.isFunctionLike(cur)) continue;
          const text = cur.getText(sf);
          const callAt = n.getStart(sf) - cur.getStart(sf);
          const beginAt = text.search(new RegExp(`\\b${g.gate}\\.begin\\(`));
          if (beginAt < 0 || beginAt > callAt) continue;
          ok = new RegExp(`\\b${g.gate}\\.(accept|isCurrent)\\(`).test(text.slice(beginAt, callAt));
          if (!ok) break;
        }
        if (!ok) bad.push(`第 ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} 行 ${n.getText(sf).slice(0, 80)}`);
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return bad;
}
for (const g of GATES) {
  check(`F2b ${g.file.replace("apps/web/src/", "")}：所有 ${g.setter}(数据) 都先过 ${g.gate}（不只 begin 后面那一处）`, () => {
    assert.deepEqual(setterCallsWithoutGate(g), [], `${g.setter} 有没过门闩的写入口`);
  });
}

// ---------------------------------------------------------------------------
// F3～F9
// ---------------------------------------------------------------------------
check("F3 客户首页运单列表：后台刷新先问让不让路、再领号；客户点的两条路都登记让路、收尾注销；补发时填了筛选条件就不发", () => {
  const src = read("apps/web/src/app/client/page.tsx");
  assert.match(src, /const orderListYield = useRef\(createYieldGuard\(\)\)\.current;/);
  const silentAt = src.indexOf("silentOrderRefreshRef.current = async");
  assert.ok(silentAt > 0, "找不到后台刷新那段");
  const silent = src.slice(silentAt, src.indexOf("\n  };", silentAt));
  const filterAt = silent.indexOf("if (queryHasFilterRef.current) return;");
  const allowAt = silent.indexOf("orderListYield.allowSilent(");
  const beginAt = silent.indexOf("orderListGate.begin()");
  assert.ok(filterAt >= 0, "补发那次没看筛选条件");
  assert.ok(allowAt >= 0 && beginAt > allowAt, "后台刷新领号在问让路之前（领了号就把客户点的那次作废了）");
  assert.ok(filterAt < beginAt, "看筛选条件要在领号之前");
  const userBegins = [...src.matchAll(/const endUser = orderListYield\.begin\(\);/g)].length;
  assert.equal(userBegins, 2, `客户点的查询登记让路应该是 2 处（执行查询、切分组），实际 ${userBegins}`);
  assert.equal([...src.matchAll(/\bendUser\(\);/g)].length, 2, "登记了让路却没在收尾注销（后台刷新会一直让下去）");
  assert.match(src, /refresh: \(isStillWanted\) => silentOrderRefreshRef\.current\(isStillWanted\)/);
});

check("F4 员工集货详情：先认主人再领号（不是当前选中的任务不拉、不领号）", () => {
  const src = read("apps/web/src/app/staff/consolidation/page.tsx");
  const fnAt = src.indexOf("const loadDetail = useCallback(async (taskId: string");
  assert.ok(fnAt > 0);
  const ownerAt = src.indexOf("if (selectedTaskIdRef.current !== taskId) return;", fnAt);
  const beginAt = src.indexOf("detailGate.begin()", fnAt);
  assert.ok(ownerAt > 0 && beginAt > ownerAt, "领号在认主人之前");
  // 点开任务的地方同步改主人（不然新点开的任务第一次就被自己挡掉）
  assert.match(src, /onClick=\{\(\) => \{ selectedTaskIdRef\.current = t\.id;[^}]*setSelectedTaskId\(t\.id\); \}\}/);
});

check("F5 整柜询价「接受」/ 报价以后按客户最后要看的那页重拉；集货余额页：三样都刷上了才清掉旧提示", () => {
  const inq = read("apps/web/src/components/client/FclInquiryPanel.tsx");
  assert.match(inq, /setAccepting\(null\);\s*\/\/[^\n]*\n\s*loadList\(wantedPageRef\.current\);/);
  assert.ok(!/setAccepting\(null\);\s*loadList\(listPage\);/.test(inq));
  // 要看的页在点翻页那一刻就记（审查第 1 轮：只在回来时更新的话，翻页在路上时操作先完成，会把人拉回旧页）；没翻成退回屏幕上那页
  assert.match(inq, /if \(!silent\) \{\s*listUserLoadsRef\.current \+= 1;\s*wantedPageRef\.current = page;\s*\}/);
  assert.match(inq, /if \(silent\) return;\s*wantedPageRef\.current = listPageRef\.current;/);
  assert.ok(!/loadList\(listPageRef\.current/.test(inq), "还有按屏幕上那页刷新的地方");
  const wallet = read("apps/web/src/app/client/wallet/page.tsx");
  assert.match(wallet, /const loadLedgerPage = useCallback\(async \(targetPage: number, opts\?: \{ silent\?: boolean \}\): Promise<boolean>/);
  assert.match(wallet, /const ledgerOk = await ledgerTask;/);
  assert.match(wallet, /if \(walletGate\.isCurrent\(walletTicket\) && overviewR\.status === "fulfilled" && recsR\.status === "fulfilled" && ledgerOk\) setMessage\(""\);/);
});

check("F6 员工页刷新被更晚的那次盖过：不写屏幕，给调用方的是屏幕上那份新的", () => {
  const src = read("apps/web/src/app/staff/page.tsx");
  assert.match(src, /if \(!pageListGate\.accept\(pageTicket, null\)\) return shownShipmentItemsRef\.current \?\? shipmentItems;\s*shownShipmentItemsRef\.current = shipmentItems;\s*setShipments\(/);
});

check("F6b 客户集货两页的余额：被更晚的盖过时给调用方屏幕上那份（付款前现读够不够不拿旧数）；余额页流水刷上清掉旧的「流水翻页失败」；装柜页一个都没加上不说「已添加」", () => {
  for (const f of ["apps/web/src/app/client/consolidation/page.tsx", "apps/web/src/app/client/whr-consolidation/page.tsx"]) {
    const src = read(f);
    assert.match(src, /if \(balanceGate\.accept\(ticket, null\)\) \{\s*shownBalanceRef\.current = v;\s*setBalance\(v\);\s*return v;\s*\}[\s\S]{0,200}?return shownBalanceRef\.current \?\? v;/, `${f} 被挡下的旧余额还给调用方`);
  }
  const wallet = read("apps/web/src/app/client/wallet/page.tsx");
  assert.match(wallet, /setLedgerPage\(res\.page\);[\s\S]{0,200}?setMessage\(\(m\) => \(m\.startsWith\("流水翻页失败"\) \? "" : m\)\);\s*return true;/);
  const loading = read("apps/web/src/app/staff/container-loading/page.tsx");
  assert.match(loading, /setError\(success > 0 \? `已添加 \$\{success\} 个，只是运单列表这次没刷新上：\$\{why\}` : `运单列表这次没刷新上：\$\{why\}`\);/);
});

check("F7 员工页「订单详情」：到仓日期当 shipDate 发，两格联动；后端不再写订单创建时间", () => {
  const src = read("apps/web/src/app/staff/page.tsx");
  assert.match(src, /shipDate: draft\.orderCreatedDate\.trim\(\) \|\| \(draft\.shipLocal\.trim\(\) \? draft\.shipLocal\.trim\(\)\.slice\(0, 10\) : null\),/);
  assert.match(src, /mergeShipmentOrderDraft\(item\.id, item, v \? \{ shipLocal: v, orderCreatedDate: v\.slice\(0, 10\) \} : \{ shipLocal: v \}\);/);
  assert.match(src, /mergeShipmentOrderDraft\(item\.id, item, \{ orderCreatedDate: v, shipLocal: v \? `\$\{v\}T\$\{draft\.shipLocal\.slice\(11, 16\) \|\| "00:00"\}` : draft\.shipLocal \}\);/);
  const api = read("apps/api/src/modules/orders/routes.ts");
  const bundleAt = api.indexOf('app.post("/staff/orders/patch-shipment-bundle"');
  const nextRoute = api.indexOf("app.", bundleAt + 10);
  assert.ok(!/createdAt:\s*arrived/.test(api.slice(bundleAt, nextRoute > 0 ? nextRoute : undefined)), "patch-shipment-bundle 又把到仓日期写进 createdAt 了");
});

check("F8 产品图：客户下预报单、员工、超管三个入口都先用 photoTypeIssue 挡；后端跟到货通知是同一份白名单", () => {
  const client = read("apps/web/src/app/client/page.tsx");
  assert.match(client, /const files = picked\.filter\(\(f\) => !photoTypeIssue\(f\)\);/);
  const staff = read("apps/web/src/app/staff/page.tsx");
  assert.match(staff, /const typeIssue = photoTypeIssue\(file\);/);
  const admin = read("apps/web/src/app/admin/page.tsx");
  assert.equal([...admin.matchAll(/const typeIssue = photoTypeIssue\(f\); if \(typeIssue\) \{ setMessage\(typeIssue\); return; \}/g)].length, 2, "超管两个上传框（手机 / 电脑）都要挡");
  const api = read("apps/api/src/modules/orders/routes.ts");
  assert.match(api, /import \{ PHOTO_MIME_ALLOWED, syncConvertedNoticesFromShipments \} from "\.\.\/arrival-notices\/routes";/);
  assert.match(api, /const mimeType = body\.mime\?\.trim\(\)\.toLowerCase\(\);/);
  assert.match(api, /if \(!PHOTO_MIME_ALLOWED\.includes\(mimeType\)\)/);
});

check("F9 改密码：页面只对员工 / 管理员 / 代理卡 8 位，客户不卡（后端同一口径）", () => {
  const shell = read("apps/web/src/modules/layout/RoleShell.tsx");
  assert.match(shell, /if \(session\?\.role !== "client" && newTrim\.length < 8\) \{/);
  const auth = read("apps/api/src/modules/auth/routes.ts");
  assert.match(auth, /const invalidReason = auth\.role === "client"\s*\?/);
});

check("F10 尾端派送候选：真跑 toLastmileCandidate —— 全部产品名、收货人 / 电话 / 地址取得到；普通和整柜两个取数函数都走它", () => {
  const file = "apps/web/src/services/business-api.ts";
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let fnText = "";
  const walk = (n: ts.Node) => { if (!fnText && ts.isFunctionDeclaration(n) && n.name?.text === "toLastmileCandidate") fnText = n.getText(sf); if (!fnText) n.forEachChild(walk); };
  walk(sf);
  assert.ok(fnText, "真源码里找不到 toLastmileCandidate");
  const sandbox: Record<string, any> = { module: { exports: {} }, productNamesLabel };
  vm.runInNewContext(ts.transpileModule(`${fnText}\nmodule.exports = toLastmileCandidate;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  const toCandidate = sandbox.module.exports as (s: any) => any;
  const row = toCandidate({
    id: "s1", trackingNo: "YW1", clientId: "XHH-1", itemName: "鞋", packageCount: 3, hasChildren: false, containerNo: "",
    products: [{ itemName: "包", sortOrder: 1 }, { itemName: "鞋", sortOrder: 0 }],
    receiverNameTh: "Somchai", receiverPhoneTh: "0812345678", receiverAddressTh: "Bangkok 10110",
  });
  assert.equal(row.itemName, "鞋 / 包", `品名没带全：${row.itemName}`);
  assert.equal(row.receiverName, "Somchai");
  assert.equal(row.receiverPhone, "0812345678");
  assert.equal(row.receiverAddress, "Bangkok 10110");
  assert.equal(row.containerNo, undefined, "空柜号要当没有");
  const bare = toCandidate({ id: "s2", trackingNo: "YW2", itemName: "灯", packageCount: null });
  assert.deepEqual([bare.itemName, bare.clientId, bare.packageCount, bare.receiverName], ["灯", "", 0, undefined]);
  const src = read(file);
  assert.match(src, /\(s\.packageCount \?\? 0\) !== 0\)\.map\(toLastmileCandidate\);/, "普通尾端候选没走 toLastmileCandidate");
  assert.match(src, /return collected\.map\(toLastmileCandidate\);/, "整柜尾端候选没走 toLastmileCandidate");
});

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e: any) { failed++; console.log(`❌ ${name}\n   ${String(e?.message ?? e).split("\n").join("\n   ")}`); }
}

async function main(): Promise<void> {
  await checkAsync("F11 客户批量下单重传同一个文件：上一批建好的行不再交、说清第几行；没确认的用回原编号；全建好过的说不用再交；收尾干净的照旧全当新单", async () => {
    const file = "apps/web/src/app/client/imports/page.tsx";
    const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let handler = "";
    const walk = (n: ts.Node) => {
      if (!handler && ts.isVariableDeclaration(n) && n.name.getText(sf) === "handleUpload" && n.initializer) handler = n.initializer.getText(sf);
      if (!handler) n.forEachChild(walk);
    };
    walk(sf);
    assert.ok(handler, "真源码里找不到 handleUpload");
    const pending = await import("../apps/web/src/modules/client-import/pending-requests");
    const importRows = await import("../apps/web/src/modules/client-import/import-rows");
    const { createRequestGate } = await import("../apps/web/src/modules/shared/request-gate");
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    const sheetOf = (names: string[]) => names.map((name, i) => ({ "仓库 *": "义乌仓", "品名 *": name, "箱数 *": i + 1, "运输方式 *（海运/陆运）": "海运" }));
    let sheet = sheetOf(["货1", "货2", "货3"]);
    let content = "同一份表";
    let userId = "ZZC1";
    let seq = 0;
    const upload = async () => {
      const out: { rows?: any[]; message?: string; fileKey?: string; lookAlike?: number[] } = {};
      const fileKeyRef = { current: "" };
      const lookAlikeRowsRef = { current: [] as number[] };
      const fn = (() => {
        const sandbox: Record<string, any> = {
          module: { exports: {} }, console,
          loading: false, parsing: false, parseGate: createRequestGate(), previewRef: { current: [] }, fileKeyRef, lookAlikeRowsRef,
          getOptionalSession: () => ({ userId }), readDoneSignatures: pending.readDoneSignatures, rowSignature: pending.rowSignature,
          XLSX: { read: () => ({ SheetNames: ["s"], Sheets: { s: {} } }), utils: { sheet_to_json: () => sheet.map((r) => ({ ...r })) } },
          fileFingerprint: pending.fileFingerprint, readPendingIds: pending.readPendingIds, readDoneRows: pending.readDoneRows, pendingStorage: () => store,
          normalizeRows: importRows.normalizeRows, isRowBad: importRows.isRowBad, newRequestId: () => `new${++seq}`,
          setParsing() {}, setMessage(m: string) { out.message = m; }, setRows(r: any[]) { out.rows = r; }, setDone() {}, setCurrent() {},
          setSuccessCount() {}, setFailCount() {}, setErrors() {},
        };
        vm.runInNewContext(ts.transpileModule(`module.exports = ${handler};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, sandbox);
        return sandbox.module.exports as (e: any) => Promise<void>;
      })();
      const bytes = new TextEncoder().encode(content).buffer;
      await fn({ target: { files: [{ name: "a.xlsx", size: 1, lastModified: 1, arrayBuffer: async () => bytes }], value: "x" } });
      out.fileKey = fileKeyRef.current;
      out.lookAlike = Array.from(lookAlikeRowsRef.current);
      return out;
    };
    // ① 第一次传：三行全新编号
    const first = await upload();
    assert.deepEqual(Array.from(first.rows ?? [], (r: any) => [r.rowNo, r.requestId]), [[2, "new1"], [3, "new2"], [4, "new3"]]);
    const key = first.fileKey!;
    assert.match(key, /^ZZC1\|sha256:/, "文件键要带唛头（别的客户用不上）");
    const sigOf = (name: string, n: number) => pending.rowSignature({ warehouseId: "wh_yiwu_01", itemName: name, packageCount: n, packageUnit: "box", transportMode: "sea", cargoType: "normal" });
    // ② 上一批：第 2 行建好了、第 3 行断网没确认、第 4 行还没发出去就刷新了 → 重传同一个文件
    pending.markPending(store, key, 2, "new1"); pending.markDone(store, key, 2, sigOf("货1", 1));
    pending.markPending(store, key, 3, "new2");
    const again = await upload();
    assert.deepEqual(Array.from(again.rows ?? [], (r: any) => [r.rowNo, r.requestId]), [[3, "new2"], [4, "new4"]], "建好的第 2 行要跳过，没确认的第 3 行用回原编号，第 4 行新编号");
    assert.match(again.message ?? "", /表格第 2 行上次已经建好了/, again.message ?? "");
    assert.match(again.message ?? "", /表格第 3 行上次发出去了、没确认建没建好/, again.message ?? "");
    // ⑤ 换了文件（第 3 行改了箱数另存）：对不上号，按内容比 —— 跟已建好的「货1」一模一样的第 2 行标出来；改过的、没建过的不标
    content = "改过的表"; sheet = sheetOf(["货1", "货2", "货3"]).map((r, i) => (i === 1 ? { ...r, "箱数 *": 9 } : r));
    const edited = await upload();
    assert.notEqual(edited.fileKey, key);
    assert.deepEqual(edited.lookAlike, [2], "跟已建好的那行一模一样的要标出来（提交前再问）");
    assert.deepEqual(Array.from(edited.rows ?? [], (r: any) => r.rowNo), [2, 3, 4], "换了文件的不自动跳过");
    assert.match(edited.message ?? "", /表格第 2 行跟上次没交完那批里已经建好的一行一模一样/, edited.message ?? "");
    // ⑥ 换了个客户在这个标签页里传同一个文件：上一个客户的记号一样都用不上
    userId = "ZZC2"; content = "同一份表"; sheet = sheetOf(["货1", "货2", "货3"]);
    const other = await upload();
    assert.match(other.fileKey ?? "", /^ZZC2\|/);
    assert.deepEqual(Array.from(other.rows ?? [], (r: any) => r.rowNo), [2, 3, 4], "别的客户的「已建好」不能拿来跳行");
    assert.ok(Array.from(other.rows ?? [], (r: any) => r.requestId).every((id: string) => id !== "new2"), "别的客户的编号不能复用");
    assert.deepEqual(other.lookAlike, [], "别的客户建好的不拿来比");
    userId = "ZZC1";
    // ③ 上一批三行全建好了、只是收尾前刷新了（还没 finishBatch）：不用再交
    pending.markDone(store, key, 3, sigOf("货2", 2)); pending.markDone(store, key, 4, sigOf("货3", 3));
    const allDone = await upload();
    assert.equal((allDone.rows ?? []).length, 0);
    assert.match(allDone.message ?? "", /上次已经全部建好了/, allDone.message ?? "");
    // ④ 收尾干净（finishBatch）以后再传同一份表：照旧全当新单（同一份表就是要再下一次）
    pending.finishBatch(store, key, false);
    const fresh = await upload();
    assert.deepEqual(Array.from(fresh.rows ?? [], (r: any) => r.rowNo), [2, 3, 4]);
    assert.ok(Array.from(fresh.rows ?? [], (r: any) => r.requestId).every((id: string) => /^new\d+$/.test(id) && !["new1", "new2", "new3", "new4"].includes(id)), "收尾干净以后要全是新编号");
    assert.ok(!/上次/.test(fresh.message ?? ""), fresh.message ?? "");
  });

  await checkAsync("F12 批量下单提交：跟上次已建好的一模一样的行先问一次（取消就一张都不交）；有明确失败的一批，建好的行留着记号", async () => {
    const file = "apps/web/src/app/client/imports/page.tsx";
    const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let handler = "";
    const walk = (n: ts.Node) => {
      if (!handler && ts.isVariableDeclaration(n) && n.name.getText(sf) === "handleSubmit" && n.initializer) handler = n.initializer.getText(sf);
      if (!handler) n.forEachChild(walk);
    };
    walk(sf);
    assert.ok(handler, "真源码里找不到 handleSubmit");
    const pending = await import("../apps/web/src/modules/client-import/pending-requests");
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    const row = (i: number) => ({ rowNo: i + 2, requestId: `req${i}`, warehouseId: "wh_yiwu_01", itemName: `货${i}`, packageCount: 1, packageUnit: "box", transportMode: "sea", cargoType: "normal", issues: [] });
    const run = async (rows: any[], lookAlike: number[], answer: boolean, rejectName: string | null) => {
      const sent: string[] = [];
      const asked: string[] = [];
      const sandbox: Record<string, any> = {
        module: { exports: {} }, console,
        loading: false, parsing: false, rows, previewRef: { current: rows }, isRowBad: () => false,
        fileKeyRef: { current: "ZZC1|sha256:f" }, lookAlikeRowsRef: { current: lookAlike },
        pendingStorage: () => store, markPending: pending.markPending, clearPending: pending.clearPending, markDone: pending.markDone,
        finishBatch: pending.finishBatch, rowSignature: pending.rowSignature,
        window: { confirm: (m: string) => { asked.push(m); return answer; } },
        setLoading() {}, setCurrent() {}, setSuccessCount() {}, setFailCount() {}, setErrors() {}, setDone() {}, setMessage() {}, setRows() {}, setUnknownCount() {},
        createClientPrealert: async (p: any) => { sent.push(p.itemName); if (p.itemName === rejectName) throw new Error("账号已封禁"); },
      };
      vm.runInNewContext(ts.transpileModule(`module.exports = ${handler};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, sandbox);
      await (sandbox.module.exports as () => Promise<void>)();
      return { sent, asked };
    };
    const cancelled = await run([row(0), row(1)], [3], false, null);
    assert.equal(cancelled.asked.length, 1, "有一模一样的行要先问一次");
    assert.match(cancelled.asked[0], /表格第 3 行跟上次没交完那批里已经建好的一行一模一样/);
    assert.deepEqual(cancelled.sent, [], "点了取消一张都不能交");
    const confirmed = await run([row(0), row(1)], [3], true, null);
    assert.deepEqual(confirmed.sent, ["货0", "货1"], "点了确定照常交");
    const notInBatch = await run([row(0)], [3], false, null);
    assert.deepEqual([notInBatch.asked.length, notInBatch.sent], [0, ["货0"]], "那一行已经不在这次要交的里面了就不问");
    // 一批里有明确失败（4xx）的：建好的那行记号留着（改好失败那行、刷新后再传同一个文件还认得出）
    mem.clear();
    await run([row(0), row(1)], [], true, "货1");
    assert.deepEqual(pending.readDoneRows(store, "ZZC1|sha256:f"), ["2"]);
    assert.deepEqual(pending.readPendingIds(store, "ZZC1|sha256:f"), {}, "明确失败的那行不算没确认");
  });

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
