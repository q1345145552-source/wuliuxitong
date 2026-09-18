/**
 * 唛头就是账号，客户名字只给内部看（2026-09-18 老板拍板，09-19 补全）。
 *
 * 老板原话：「唛头=账号，客户名字是只有我们内部看的」「标着『唛头』还是显示唛头……除了登录页是显示账号，内部其他地方都是显示唛头」。
 * 09-19 又定了两条：显示唛头时旁边**不带名字**（「显示唛头就行了」）；
 * 客户下预报单时自己填的那个「唛头」（mark 字段，常跟账号不一样）**原样不动**（「都标着『唛头』了，为什么还要改」）。
 *
 * 起因：超管「运单管理」→「详情」里的「唛头」写成了「有名字就显示名字」，XHH6700 显示成了「杨先」——
 * 而「杨先」名下有 3 个账号，线上 12 个名字对应了 37 个账号，只看名字分不清是哪个唛头。
 * 同一个写法还在打印标签、派送签收单「收货人」格、仓库版 / 普通版集货、财务、柜子收款、充值审核等十几处。
 *
 * ⚠️ 第一版测试是「按原来那几种写法逐字找」，两位复核一换写法（`||` 代替 `??`、多个空格、先赋给变量再显示）就拦不住。
 * 这一版反过来：**把页面和接口里每一处读客户名字的地方都找出来，逐处对「允许清单」**——
 * 允许的只有：类型声明、搜索（按名字也能搜）、客户管理页、老板点名保留名字的两处、以及内部接口给这些用的字段。
 * 多出任何一处（不管怎么写）都报错，报错里写清是哪个文件第几行，由改的人决定是改掉还是（问过老板后）加进清单。
 *
 * 代理端不在这份测试里：代理看的是他自己的客户，老板说带名字没事（components/agent、app/agent、[agentSlug]、agent-portal）。
 * 派送签收单上真印出来的是什么，由 test-lastmile-export 第 18、19 项真生成一张来核。
 * 用法：npm run test:mark-display
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(path.join(ROOT, p), "utf-8");
let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${name}\n     ${(e instanceof Error ? e.message : String(e)).split("\n").join("\n     ")}`);
  }
}

/** 去掉注释，但保留换行（行号还要对得上）。`//` 前面是 `:` 的不算（网址）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(?<![:\\])\/\/.*$/gm, "");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(rel);
  }
  return out;
}

type Hit = { file: string; line: number; text: string };
/**
 * 任何 `X.name` / `X?.name` / `X!.name`（包括折行后行首的 `?.name`）都算「可能在读名字」，
 * 除非「X」在这个文件里明确不是客户（文件名、报错、品牌、代理……，见各自的 NOT_CLIENT 清单）。
 * ⚠️ 第 2 版只认一组写死的变量名，两位复核换个变量名（`selectedCl?.name`、`hit?.name`、`owner?.name`）就绕过去了，
 *    所以反过来：默认可疑，只放行点名的非客户对象。
 */
const DOT_NAME = /([\w$\])]*)\s*[?!]?\.name\b/g;
type NotClient = { file: RegExp; recv: RegExp; why: string };
function suspiciousLine(file: string, text: string, field: RegExp, notClient: NotClient[]): boolean {
  const exempt = notClient.filter((n) => n.file.test(file));
  return field.test(text) || [...text.matchAll(DOT_NAME)].some((m) => !exempt.some((n) => n.recv.test(m[1])));
}
function scan(files: string[], field: RegExp, notClient: NotClient[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    stripComments(read(file)).split("\n").forEach((text, i) => {
      if (suspiciousLine(file, text, field, notClient)) hits.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return hits;
}
type Allow = { file: string; re: RegExp; why: string };
function assertAllAllowed(hits: Hit[], allow: Allow[], generic: Array<{ re: RegExp; why: string }> = []): void {
  const bad = hits.filter((h) =>
    !generic.some((g) => g.re.test(h.text)) &&
    !allow.some((a) => a.file === h.file && a.re.test(h.text)));
  assert.equal(bad.length, 0, `这些地方在读客户名字，不在允许清单里（显示客户要用唛头 clientId）：\n${bad.map((h) => `${h.file}:${h.line}  ${h.text.slice(0, 160)}`).join("\n")}`);
}

/* ─────────────────────────── 页面 ─────────────────────────── */

const AGENT_SIDE = /\/components\/agent\/|\/app\/agent\/|\[agentSlug\]|\/services\/agent-api\.ts$/;
const webFiles = walk("apps/web/src").filter((f) => !AGENT_SIDE.test(f));

/** 页面里「读客户名字」：clientName / customerName 字段，或者任何不在 WEB_NOT_CLIENT 里的 `.name` */
const WEB_FIELD = /\bclientName\b|\bcustomerName\b/;
const WEB_NOT_CLIENT: NotClient[] = [
  { file: /./, recv: /^(?:file|f|certFile|error|e|err)$/, why: "文件名 / 报错名" },
  { file: /\/modules\/branding\/|\/app\/login\/page\.tsx$|\/app\/register\/page\.tsx$|\/modules\/layout\/RoleShell\.tsx$/, recv: /^(?:brand|info|current|state|r|a|b)$/, why: "品牌名" },
  { file: /\/app\/client\/track\/page\.tsx$/, recv: /^sessionBrand$/, why: "品牌名" },
  { file: /\/app\/admin\/agents\/|\/components\/admin\/agents\//, recv: /^(?:a|agent|resetFor)$/, why: "代理名" },
  { file: /\/app\/admin\/page\.tsx$/, recv: /^(?:clientForm|staffForm)$/, why: "客户管理 / 员工管理的编辑表单" },
  { file: /\/app\/admin\/page\.tsx$/, recv: /^(?:a|agentId\))$/, why: "开客户时选代理（代理名）" },
  { file: /\/services\/business-api\.ts$/, recv: /^a$/, why: "代理下拉（fetchAgentOptions）" },
  { file: /\/app\/client\/consolidation\/page\.tsx$/, recv: /^s$/, why: "品名汇总" },
];

const WEB_GENERIC: Array<{ re: RegExp; why: string }> = [
  { re: /^\s*(?:readonly\s+)?(?:clientName|customerName)\??:\s*string\b[^,;]*[;,]?\s*$/, why: "类型声明（单独一行）" },
  { re: /^(?:[\w?]+:\s*[\w| ]+;\s*)*(?:clientName|customerName)\??:\s*string(?:\s*\|\s*null)?;/, why: "类型声明（一行里好几个字段）" },
];

const WEB_ALLOW: Allow[] = [
  // ── 搜索：按名字也能搜，但不显示 ──
  { file: "apps/web/src/app/admin/prealerts/page.tsx", re: /^const searchText = `.*\$\{item\.clientName \?\? ""\}`\.toLowerCase\(\);$/, why: "预报单搜索" },
  { file: "apps/web/src/app/staff/page.tsx", re: /^const searchText = `.*\$\{item\.clientName \?\? ""\}`\.toLowerCase\(\);$/, why: "预报单搜索" },
  { file: "apps/web/src/app/admin/consolidation/page.tsx", re: /^list = list\.filter\(\(t\) => .*\(t\.clientName \?\? ""\)\.toLowerCase\(\)\.includes\(s\)\);$/, why: "普通版集货搜索" },
  { file: "apps/web/src/app/staff/consolidation/page.tsx", re: /^list = list\.filter\(\(t\) => .*\(t\.clientName \?\? ""\)\.toLowerCase\(\)\.includes\(s\)\);$/, why: "普通版集货搜索" },
  { file: "apps/web/src/app/admin/whr-consolidation/page.tsx", re: /^\(cl\.name \?\? ""\)\.toLowerCase\(\)\.includes\(q\) \|\|$/, why: "建柜选客户搜索" },
  { file: "apps/web/src/app/admin/whr-consolidation/page.tsx", re: /^!q \|\| cl\.id\.toLowerCase\(\)\.includes\(q\) \|\| \(cl\.name \?\? ""\)\.toLowerCase\(\)\.includes\(q\)$/, why: "加客户搜索" },
  { file: "apps/web/src/app/staff/whr-consolidation/page.tsx", re: /^\.filter\(cl => !q \|\| cl\.id\.toLowerCase\(\)\.includes\(q\) \|\| \(cl\.name \?\? ""\)\.toLowerCase\(\)\.includes\(q\)\);$/, why: "加客户搜索" },
  { file: "apps/web/src/components/lastmile/LastmileAddressPanel.tsx", re: /^!keyword \|\| c\.id\.toLowerCase\(\)\.includes\(keyword\.toLowerCase\(\)\) \|\| c\.name\.toLowerCase\(\)\.includes\(keyword\.toLowerCase\(\)\)\);$/, why: "地址簿搜索" },
  { file: "apps/web/src/modules/lastmile/viewModel.ts", re: /^order\.clientName,$/, why: "派送工作台搜索（searchable 数组里的一项）" },
  // 运单列表「唛头 / 客户名」那一格筛选：拼的是「名字 + 唛头」一起搜
  { file: "apps/web/src/app/admin/page.tsx", re: /^trackingNo: "", domesticTrackingNo: "", clientName: "", warehouseId: "",$/, why: "运单筛选的初始值" },
  { file: "apps/web/src/app/admin/page.tsx", re: /^const cn = `\$\{item\.clientName \?\? ""\} \$\{item\.clientId \?\? ""\}`\.toLowerCase\(\);$/, why: "运单筛选" },
  { file: "apps/web/src/app/admin/page.tsx", re: /^if \(s\.clientName && !cn\.includes\(s\.clientName\.toLowerCase\(\)\)\) return false;$/, why: "运单筛选" },
  { file: "apps/web/src/app/staff/page.tsx", re: /^clientName: "",$/, why: "运单筛选的初始值" },
  { file: "apps/web/src/app/staff/page.tsx", re: /^const clientNameKeyword = shipmentSearch\.clientName\.trim\(\)\.toLowerCase\(\);$/, why: "运单筛选" },
  { file: "apps/web/src/app/staff/page.tsx", re: /^const clientName = `\$\{item\.clientName \?\? ""\} \$\{item\.clientId \?\? ""\}`\.toLowerCase\(\);$/, why: "运单筛选" },
  { file: "apps/web/src/app/staff/page.tsx", re: /^if \(clientNameKeyword && !clientName\.includes\(clientNameKeyword\)\) return false;$/, why: "运单筛选" },
  { file: "apps/web/src/modules/shipment/ShipmentSearch.tsx", re: /^clientName: "唛头 \/ 客户名",$|^const BASIC_FILTER_FIELDS = new Set<SearchField>\(\[.*"clientName".*\]\);$|^\{textField\("clientName"\)\}$/, why: "筛选格子的字段名 / 标签" },

  // ── 老板点名保留名字的两处（2026-09-18「这两个不要换」）──
  { file: "apps/web/src/app/staff/page.tsx", re: /^归属用户: item\.clientName \?\? item\.clientId \?\? "-",$/, why: "员工运单导出「归属用户」" },
  { file: "apps/web/src/app/staff/page.tsx", re: /^value=\{item\.clientName \?\? item\.clientId \?\? "—"\}$/, why: "员工运单「运单所属用户」" },

  // ── 客户管理页：名字就是在这里给内部看、给内部改的 ──
  { file: "apps/web/src/app/admin/page.tsx", re: /^\[u\.id, u\.name, u\.companyName, u\.phone, u\.email\]$/, why: "客户管理搜索" },
  { file: "apps/web/src/app/admin/page.tsx", re: /^<span><strong>客户名字<\/strong> \{u\.name\}<\/span>$/, why: "客户管理卡片" },
  { file: "apps/web/src/app/admin/page.tsx", re: /^name: u\.name,$/, why: "客户管理「编辑」带出原名字" },
  { file: "apps/web/src/app/admin/page.tsx", re: /^<span><strong>姓名<\/strong> \{u\.name\}<\/span>$|^onClick=\{\(\) => void confirmToggleBan\(u\.id, u\.name, u\.status, loadStaff, "员工"\)\}$/, why: "员工管理（员工不是客户）" },

  // ── 不是客户名字 ──
  { file: "apps/web/src/app/admin/page.tsx", re: /^<Cell key=\{item\.name\} fill=\{item\.color\} \/>$/, why: "图表色块" },
  { file: "apps/web/src/app/client/page.tsx", re: /^<Cell key=\{item\.name\} fill=\{item\.color\} \/>$/, why: "图表色块" },
  { file: "apps/web/src/app/client/track/page.tsx", re: /^if \(option\.name\.toLowerCase\(\)\.includes\(normalized\)\) return true;$|^\{item\.name\}（\{item\.code\}）$/, why: "查件页的选项名" },

];

/* ─────────────────────────── 接口 ─────────────────────────── */

/** 代理端接口（代理看自己的客户）、登录（登录返回自己的名字，老板知道，不在这次改） */
const API_EXEMPT = /\/modules\/agent-portal\/|\/modules\/auth\//;
const apiFiles = walk("apps/api/src").filter((f) => !API_EXEMPT.test(f));
const API_FIELD = /\bclientName\w*\b|\bcustomerName\b/;
const API_NOT_CLIENT: NotClient[] = [
  { file: /./, recv: /^(?:this|target|error|e|err)$/, why: "报错类名" },
  // ⚠️ 当前登录的人：写进日志的「操作人 / 建柜人」。客户自己操作时这里是客户名字，超管看记录能看到（另议，没在这次改）
  { file: /./, recv: /^auth$/, why: "当前登录的人" },
  { file: /\/modules\/branding\//, recv: /^(?:brand|row)$/, why: "品牌名" },
  { file: /\/modules\/agents\//, recv: /^(?:a|agent|body|actor)$/, why: "代理名 / 代理管理的输入 / 返现单操作人" },
  { file: /\/modules\/admin\/routes\.ts$/, recv: /^(?:agent|body|updateData|created|updated|reviewer)$/, why: "客户管理 / 员工管理的增改、代理名、审核人" },
  { file: /\/modules\/shipments\/routes\.ts$/, recv: /^u$/, why: "轨迹操作人名字表" },
  { file: /\/modules\/shipments\/unload-item\.ts$/, recv: /^operator$/, why: "卸柜操作人（员工）" },
];
/**
 * 接口里允许出现客户名字的只有这些：都是**员工 / 超管**的列表接口，给上面那些「按名字也能搜」和老板保留的两处用。
 * ⚠️ 往外发的（派送签收单、客户自己的接口、财务 / 柜子收款的显示值）一处都不许有。
 */
const API_ALLOW: Allow[] = [
  { file: "apps/api/src/modules/shipments/routes.ts", re: /^clientName: r\.order\?\.client\?\.name \?\? undefined,$/, why: "员工运单列表（运单所属用户 / 归属用户 / 搜索）" },
  { file: "apps/api/src/modules/admin/routes.ts", re: /^clientName: r\.order\?\.client\?\.name \?\? undefined,$/, why: "超管运单列表（搜索）" },
  { file: "apps/api/src/modules/admin/routes.ts", re: /^name: r\.name,$/, why: "客户管理 / 员工管理列表（/admin/users）" },
  { file: "apps/api/src/modules/orders/routes.ts", re: /^clientName: o\.client\?\.name \?\? null,$/, why: "员工预报单列表（搜索）" },
  { file: "apps/api/src/modules/consolidation/routes.ts", re: /^clientName: (?:t|task)\.client\.name,$/, why: "普通版集货员工 / 超管接口（搜索）" },
  { file: "apps/api/src/modules/admin-ops/routes.ts", re: /^clientName: order\?\.client\?\.name \?\? null,$/, why: "尾端派送列表（搜索）" },
  { file: "apps/api/src/modules/shipping-config/routes.ts", re: /^customerName: null as string \| null,$/, why: "运费配置：恒为空，没发名字" },
];
/** 每个文件最多几处（防止在同一个文件里「照着允许的那行再抄一份」给客户接口） */
const API_MAX_PER_FILE: Record<string, number> = {
  "apps/api/src/modules/shipments/routes.ts": 1,
  "apps/api/src/modules/admin/routes.ts": 2,
  "apps/api/src/modules/orders/routes.ts": 1,
  "apps/api/src/modules/consolidation/routes.ts": 3,
  "apps/api/src/modules/admin-ops/routes.ts": 1,
  "apps/api/src/modules/shipping-config/routes.ts": 1,
};

console.log("唛头显示（唛头=账号，客户名字只给内部看）");

check("1) 页面里每一处读客户名字的地方都在允许清单里（换写法也拦得住）", () => {
  const hits = scan(webFiles, WEB_FIELD, WEB_NOT_CLIENT);
  assert.ok(hits.length >= 20, `只扫到 ${hits.length} 处，扫描本身可能坏了`);
  assertAllAllowed(hits, WEB_ALLOW, WEB_GENERIC);
});

check("2) 接口里每一处读客户名字的地方都在允许清单里，且每个文件不超过该有的处数", () => {
  const hits = scan(apiFiles, API_FIELD, API_NOT_CLIENT);
  assert.ok(hits.length >= 8, `只扫到 ${hits.length} 处，扫描本身可能坏了`);
  assertAllAllowed(hits, API_ALLOW);
  const perFile = new Map<string, number>();
  for (const h of hits) perFile.set(h.file, (perFile.get(h.file) ?? 0) + 1);
  for (const [file, n] of perFile) {
    assert.ok(n <= (API_MAX_PER_FILE[file] ?? 0), `${file} 里有 ${n} 处客户名字，应该最多 ${API_MAX_PER_FILE[file] ?? 0} 处`);
  }
  // 往外发的、给客户的、财务的：一处都不许有（上面清单里本来就没有它们，这里点名再钉一次）
  for (const file of [
    "apps/api/src/modules/loading-manifests/routes.ts",
    "apps/api/src/modules/finance/routes.ts",
    "apps/api/src/modules/whr-consolidation/client-routes.ts",
    "apps/api/src/modules/whr-consolidation/long-term-price.ts",
    "apps/api/src/modules/agents/admin-routes.ts",
    "apps/api/src/modules/whr-consolidation/routes.ts",
    "apps/api/src/modules/whr-consolidation/staff-routes.ts",
  ]) {
    assert.ok(!perFile.has(file), `${file} 里出现了客户名字`);
  }
});

/**
 * 客户能调的接口（路径以 /client/ 开头）：查询里不许带名字、不许把客户整行带出来。
 * ⚠️ 上面那道扫描只看得见 `.name`，看不见「查询里 select 了 name，再把整个 client 对象原样返回」
 *    —— Opus 第 2 轮实测过这样能绕过（CLAUDE.md #31：接口返回里有就是泄漏）。
 */
const CLIENT_ROUTE_BAD = /\bname\s*:\s*true\b|\b(?:client|user|users|owner|customer)\s*:\s*true\b|\.\.\.\s*[\w.?]*\bclient\b|([\w$\])]*)\s*[?!]?\.name\b/g;
function clientRouteViolations(file: string, src: string): string[] {
  const code = stripComments(src);
  const routes = [...code.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*"([^"]+)"/g)];
  const out: string[] = [];
  routes.forEach((m, i) => {
    if (!m[1].startsWith("/client/")) return;
    const body = code.slice(m.index!, i + 1 < routes.length ? routes[i + 1].index! : undefined);
    for (const b of body.matchAll(CLIENT_ROUTE_BAD)) {
      // 当前登录的人自己（写日志的操作人）、/client/brand 的品牌名，不算
      if (b[1] === "auth" || (m[1] === "/client/brand" && b[1] === "brand")) continue;
      out.push(`${file}:${code.slice(0, m.index! + b.index!).split("\n").length}  ${m[1]}  ${b[0]}`);
    }
  });
  return out;
}
let clientRouteCount = 0;

check("2b) 客户能调的接口（/client/...）：查询里不带名字、不整行带出客户、不读 .name", () => {
  const bad: string[] = [];
  for (const file of apiFiles) {
    const src = read(file);
    clientRouteCount += [...src.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*"\/client\//g)].length;
    bad.push(...clientRouteViolations(file, src));
  }
  assert.ok(clientRouteCount >= 30, `只找到 ${clientRouteCount} 个客户接口，扫描本身可能坏了`);
  assert.equal(bad.length, 0, `客户接口里有名字：\n${bad.join("\n")}`);
});

check("3) 派送签收单「收货人」：没填就留空，不许退到客户名字（接口两条路都查）", () => {
  const ops = stripComments(read("apps/api/src/modules/admin-ops/routes.ts"));
  const lm = stripComments(read("apps/api/src/modules/loading-manifests/routes.ts"));
  // 收货人 / 联系人那几条兜底链上不许挂客户对象上的任何字段名 name（不管中间怎么写）
  for (const [who, src] of [["尾端派送", ops], ["装柜清单", lm]] as Array<[string, string]>) {
    for (const m of src.matchAll(/(?:contactName|receiverName)\s*[:=][^\n]*/g)) {
      assert.ok(!/client\??\.name|\.name\b/.test(m[0]), `${who}的收货人兜底里有名字：${m[0].trim()}`);
    }
  }
  // 往外发的两个导出接口连客户名字都不查（查了就容易被人顺手用上）
  const exportRoute = ops.slice(ops.indexOf('"/admin/lastmile/customer-export-data"'));
  const exportBody = exportRoute.slice(0, exportRoute.indexOf("app.get(", 10) > 0 ? exportRoute.indexOf("app.get(", 10) : undefined);
  assert.ok(!/client:\s*\{\s*select:\s*\{[^}]*\bname:\s*true/.test(exportBody), "客户签收单导出接口还在查客户名字");
  assert.ok(!/client:\s*\{\s*select:\s*\{[^}]*\bname:\s*true/.test(lm), "装柜清单导出接口还在查客户名字");
});

check("4) 超管运单详情、打印标签（超管、员工）上的唛头是账号", () => {
  assert.match(read("apps/web/src/components/admin/AdminShipmentDetail.tsx"), /\["唛头", display\(order\.clientId\)\]/, "详情「唛头」没用 clientId");
  for (const [who, file] of [["超管", "apps/web/src/app/admin/page.tsx"], ["员工", "apps/web/src/app/staff/page.tsx"]]) {
    const marks = [...read(file).matchAll(/openPrintLabel\(\{\s*marks:\s*([^,]+),/g)].map((m) => m[1]);
    assert.ok(marks.length >= 1, `${who}端找不到打印标签`);
    for (const m of marks) assert.match(m, /^\s*\w+\.clientId\b/, `${who}端标签唛头印的是 ${m}`);
  }
});

check("5) 选客户的下拉只显示唛头：选项值就是唛头，选中后按唛头认", () => {
  const staff = read("apps/web/src/app/staff/page.tsx");
  const options = [...staff.matchAll(/<option key=\{item\.id\} value=\{([^}]+)\} \/>/g)].map((m) => m[1]);
  assert.equal(options.length, 2, `员工创建订单的两个客户下拉应该各有一处，找到 ${options.length} 处`);
  for (const v of options) assert.equal(v, "item.id", `下拉选项值不是唛头：${v}`);
  const matchers = [...staff.matchAll(/allClientOptions\.find\(\(c\) => ([^)]*\))\)/g)].map((m) => m[1]);
  assert.ok(matchers.filter((m) => m.startsWith("c.id === e.target.value")).length === 2, `选中后不是按唛头认的：${matchers.join(" / ")}`);
  // 不是完整唛头就清空「已选唛头」：线上有「XPP-0015」和「XPP-0015 XHH-6698」这种，一个是另一个的开头，
  // 只选不清的话打到一半会停在短的那个账号上（Opus 第 2 轮报）
  assert.equal([...staff.matchAll(/setForm\(\(v\) => \(\{ \.\.\.v, clientId: match \? match\.id : "" \}\)\)/g)].length, 2, "输入框不是完整唛头时没把「已选唛头」清空");
  // 下拉里一个字都不许拼名字（`${id} - ${name}`、`{c.id} - {c.name}` 这种）
  for (const file of ["apps/web/src/app/staff/page.tsx", "apps/web/src/app/admin/page.tsx", "apps/web/src/components/client/FclInquiryPanel.tsx"]) {
    const src = stripComments(read(file));
    // 只看客户对象（c / cl / item / client / u）上的 name；超管建客户时那个「开在代理『{a.name}』名下」是代理名字，不算
    const CLIENT_NAME = String.raw`\b(?:c|cl|item|client|u)\??\.name\b`;
    assert.ok(!new RegExp(String.raw`<option\b[^>]*>[^<]*` + CLIENT_NAME).test(src) && !new RegExp(String.raw`<option\b[^>]*value=\{\`[^\`]*` + CLIENT_NAME).test(src), `${file} 的下拉选项里还拼着名字`);
  }
});

check("6) 财务、柜子收款、尾端派送工作台、客户自己的仓库版页面：显示的是唛头", () => {
  assert.match(read("apps/api/src/modules/finance/routes.ts"), /client: t\.clientId \|\| "—",/, "财务页普通版那一行没显示唛头");
  // 仓库版那一行显示的是客户自填的唛头，按账号搜要靠单独发的 clientId
  assert.match(read("apps/api/src/modules/finance/routes.ts"), /clientId: p\.planCustomer\?\.clientId \?\? "",/, "财务页仓库版那一行没带账号，按账号搜不到");
  assert.match(read("apps/web/src/app/admin/finance/page.tsx"), /r\.clientId\.toLowerCase\(\)\.includes\(kw\)/, "财务页搜索不能按账号搜");
  const ops = read("apps/api/src/modules/admin-ops/routes.ts");
  assert.match(ops, /clientId: c\.clientId \|\| "—",/, "柜子收款仓库版客户明细没显示唛头");
  assert.match(ops, /clientId: t\.clientId \|\| "—",/, "柜子收款普通版客户明细没显示唛头");
  assert.match(read("apps/web/src/app/admin/settlement/page.tsx"), /↳ \{c\.clientId\}/, "柜子收款页面没显示唛头");
  assert.match(read("apps/web/src/modules/lastmile/LastmileDispatchWorkspace.tsx"), /<strong>\{customer\.clientId\}<\/strong>/, "尾端派送工作台客户标题没显示唛头");
  assert.match(read("apps/api/src/modules/whr-consolidation/client-routes.ts"), /clientId: auth\.userId,/, "客户仓库版接口没发唛头");
  assert.match(read("apps/web/src/app/client/whr-consolidation/page.tsx"), /\{detail\.clientId\}/, "客户仓库版页面顶上没显示唛头");
});

check("7) 员工仓库版导出表：「客户」列和小计行是唛头；客户自己填的「唛头」列原样不动", () => {
  const src = read("apps/web/src/app/staff/whr-consolidation/page.tsx");
  assert.match(src, /"目的地", "客户", "预报单号", "唛头"/, "导出表头不对");
  assert.equal([...src.matchAll(/p\.destinationTh, c\.clientId,/g)].length, 3, "导出三种行的「客户」列不全是唛头");
  assert.match(src, /`\$\{c\.clientId\} 小计`/, "小计行不是唛头");
  // 客户自己填的唛头（pa.mark）老板说不动（2026-09-19）
  assert.match(src, /c\.clientId, pa\.trackingNo, pa\.mark,/, "导出表「唛头」列被改了（客户自己填的唛头原样不动）");
});

check("8) 客户自己填的「唛头」原样显示，没被换成账号（2026-09-19 老板：「都标着『唛头』了，为什么还要改」）", () => {
  assert.match(read("apps/api/src/modules/finance/routes.ts"), /client: p\.mark \|\| "—",/, "财务页仓库版那一行被改了");
  const staffWhr = read("apps/web/src/app/staff/whr-consolidation/page.tsx");
  assert.match(staffWhr, /唛头：\{reviewTarget\.prealert\.mark \|\| "-"\}/, "员工仓库版审核弹窗里的唛头被改了");
});

check("9) 老板说保留名字的两处原样不动：员工运单「运单所属用户」、员工运单导出「归属用户」", () => {
  const staff = read("apps/web/src/app/staff/page.tsx");
  assert.match(staff, /label="运单所属用户"[\s\S]{0,200}value=\{item\.clientName \?\? item\.clientId \?\? "—"\}/, "「运单所属用户」被改了（老板说这个不换）");
  assert.match(staff, /归属用户: item\.clientName \?\? item\.clientId \?\? "-"/, "导出「归属用户」被改了（老板说这个不换）");
});

check("10) 自检：扫描真能抓到换了写法的「名字当唛头」（含两位复核第 2 轮实测绕过的写法）", () => {
  const WEB_AT = "apps/web/src/app/staff/page.tsx";
  for (const variant of [
    "<dd>{order.clientName || order.clientId}</dd>",
    "<dd>{ order.clientName  ??  order.clientId }</dd>",
    "const who = row.clientName; return <b>{who}</b>;",
    "{allClientOptions.find((c) => c.id === row.clientId)?.name ?? row.clientId}",
    "<option value={c.id}>{c.id} - {c.name}</option>",
    "value={`${item.id} - ${item.name}`}",
    "<strong>{selectedCl?.name}</strong>",
    "const hit = staffClients.find((c) => c.id === id); return hit?.name;",
    "?.name ?? \"\"}",
    "<td>{target.name}</td>",
  ]) {
    assert.ok(suspiciousLine(WEB_AT, variant, WEB_FIELD, WEB_NOT_CLIENT), `页面扫描抓不到：${variant}`);
    assert.ok(!WEB_GENERIC.some((g) => g.re.test(variant.trim())), `页面扫描把它当成了类型声明放行：${variant}`);
    assert.ok(!WEB_ALLOW.some((a) => a.file === WEB_AT && a.re.test(variant.trim())), `页面允许清单把它放行了：${variant}`);
  }
  const API_AT = "apps/api/src/modules/admin/routes.ts";
  for (const variant of [
    "contactName: order?.receiverNameTh?.trim() || defaultAddress?.contactName || order?.client?.name || \"\",",
    "client: t.client?.name ?? t.clientId,",
    "customerName: customer.client.name,",
    "owner: users.find((u) => u.id === clientId)?.name ?? \"\",",
    "who: row.client!.name,",
    "owner: owner?.name,",
  ]) {
    assert.ok(suspiciousLine(API_AT, variant, API_FIELD, API_NOT_CLIENT), `接口扫描抓不到：${variant}`);
    assert.ok(!API_ALLOW.some((a) => a.file === API_AT && a.re.test(variant.trim())), `接口允许清单把它放行了：${variant}`);
  }
  // 客户接口：select 了 name 再整个 client 原样返回、include client: true、展开 client —— 都要抓到
  for (const route of [
    'app.get("/client/x", async (req, res) => { const c = await prisma.a.findFirst({ include: { client: { select: { name: true, phone: true } } } }); ok(res, { client: c.client }); });',
    'app.get("/client/x", async (req, res) => { const c = await prisma.a.findFirst({ include: { client: true } }); ok(res, c); });',
    'app.get("/client/x", async (req, res) => { const c = await prisma.a.findFirst({}); ok(res, { ...c.client }); });',
  ]) {
    assert.ok(clientRouteViolations("x.ts", route).length > 0, `客户接口扫描抓不到：${route}`);
  }
  // 已知抓不到的：解构（`({ name }) => name`）。这类写法靠代码复查，不靠这份测试。
});

if (failures > 0) {
  console.log(`❌ 失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 唛头显示：11 项全部通过");
