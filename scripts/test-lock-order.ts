/**
 * 加锁顺序的自测（只读源码，不连数据库）。
 *
 * 为什么要有这个：2026-08-28 我用正则扫「每个事务里 FOR UPDATE 的先后」，
 * 得出「17 条路径锁序统一」——**那个结论是错的**。
 * 正则只看得见加锁语句，看不见**锁之前已经写了什么**：
 * 管理员强改预报单实际是「先删改产品行 → 才加锁」，等于没锁。
 * 复核实测把这条揪了出来。
 *
 * 所以这个脚本查两件事，缺一不可：
 *   ① **第一条写语句必须排在第一把锁后面**（不然锁等于白加）；
 *   ② 同一模块里所有事务的**加锁顺序必须一致**（方向相反会死锁）。
 *
 * ⚠️ 这是**静态检查**，认不出通过函数间接加的锁（比如 plan-guard 里那几个 helper）。
 * 所以下面对那些 helper 做了显式映射；新增 helper 要记得加进来，
 * 否则这个脚本会把它当成「没加锁就写」而误报 —— 误报比漏报好。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "apps", "api", "src", "modules");

/**
 * 模型名 → 表名。用来把「写一张表」也算成「在这一刻拿到了这张表的锁」。
 *
 * ⚠️⚠️ 这是 2026-08-29 补的、这个扫描器最要紧的一条改动。
 *
 * 第七轮复核真实复现出「分柜 vs 卸柜」死锁，而这一项当时是**绿的**：
 * 分柜只 `create` 柜内记录、**不发 FOR UPDATE**，扫描器看到的锁序里
 * 就没有 shipment_container_items 这一站，自然不违反任何顺序。
 *
 * 但**「没发 FOR UPDATE」不等于「没拿锁」**：
 * insert 撞上唯一索引 `(container_id, shipment_id)` 时照样要等对方那一行，
 * update / delete 更是当场就拿行锁。
 * 所以只看 FOR UPDATE 的扫描器，天生看不见一半的锁。
 */
const MODEL_TABLE: Record<string, string> = {
  container: "containers",
  shipment: "shipments",
  shipmentContainerItem: "shipment_container_items",
  order: "orders",
  adminLastmileOrder: "admin_lastmile_orders",
};

/** 间接加锁的 helper：调用它 = 锁了这些表（按顺序） */
const LOCK_HELPERS: Record<string, string[]> = {
  lockPlanAliveById: ["whr_consolidation_plans"],
  lockPlanAliveByPrealert: ["whr_consolidation_plans"],
  lockPlanByPrealert: ["whr_consolidation_plans"],
  lockPrealertExpecting: ["whr_consolidation_prealerts"],
  /**
   * ⚠️ 这个 helper 第一件事就是 `SELECT ... FROM shipments ... FOR UPDATE`
   * 锁住父单（parent-status.ts:105）。2026-08-29 之前它没登记在这里 ——
   * 于是「把父单锁改成反序」这个变异，7 项照样全绿。
   * 新增间接加锁的 helper 一定要登记，不然这个脚本就是睁眼瞎。
   */
  syncParentStatusFromChildren: ["shipments"],
  /**
   * ⚠️ 2026-08-29 新增的共用批量锁。**新加间接加锁的 helper 必须登记在这里**，
   * 否则这个脚本会把它当成「没加锁就写」而误报 —— 或者更糟，
   * 把用了它的地方当成「压根没锁」。
   * （`syncParentStatusFromChildren` 上个月就是漏登记，
   *   导致「父单锁改成反序」这个变异全绿。）
   */
  lockShipmentsChildrenFirst: ["shipments"],
  lockParentsByTrackingNo: ["shipments"],
  lockAndSyncParents: ["shipments"],
  /**
   * ⚠️ 2026-08-31 新增：这两个取号函数第一件事就是 pg_advisory_xact_lock
   * （排队锁握到事务提交），是「客户建预报单 / 建集货任务」两条纯插入事务
   * 里真正的那把锁。不登记的话第 1 项会把它们当成「没锁就写」误报。
   * 用的是假表名（advisory_ 前缀），不参与第 2/3 项的表顺序比对。
   * ⚠️ 别把 orders/routes.ts:124 那个同名 generateTrackingNo 登进来 ——
   * 它不带 tx、没有锁，登了就是给它白发绿灯（所以这里只登这两个独名的；
   * consolidation 那个 generateTrackingNo 由第 10 项单独点名核查）。
   * ⚠️ 登在这里只是「免误报」，锁本身还在不在由第 10 项去函数体里核实
   * （2026-08-31 Codex 复核：原来把 generateTaskNo 里的锁真删掉，照样全绿）。
   */
  generatePrealertNo: ["advisory_prealert_no"],
  generateTaskNo: ["advisory_consolidation_task_no"],
  /**
   * ⚠️ 2026-09-16 代理账号新增：客户长期价排队锁（long-term-price.ts，pg_advisory_xact_lock(83020, …)）。
   * 锁序：客户价锁 → 代理行 → 计划 → 预报单 → 钱包。建柜、往柜里加客户、超管改长期价、
   * 改客户归属这几条路的第一把锁就是它；不登记的话第 1 项会把它们当成「没锁就写」误报，
   * 第 6 项也认不出「按 clientId 排序逐个锁」那个循环。第 10 项会去函数体里核实锁真的在。
   */
  lockClientWhrPrice: ["advisory_client_whr_price"],
};

const WRITE_RE = /\btx\.\w+\.(create|update|updateMany|delete|deleteMany|upsert|createMany)\b/;
/**
 * ⚠️ **raw SQL 写入也是写**（2026-08-29 补）。
 * 独立变异实测：在第一把锁前面塞一句 `tx.$executeRaw\`UPDATE ...\``，
 * 上面那条正则只认 `tx.模型.方法`，**一个都抓不到，5 项照样全绿**。
 * 注意别把 `SELECT ... FOR UPDATE` 当成写 —— 它里面也有 UPDATE 这个词，
 * 所以必须匹配到 `UPDATE 表名 SET` 这种完整形状。
 */
const RAW_WRITE_RE = /\btx\.\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe)\b/;
const RAW_WRITE_SQL_RE = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i;

/**
 * 这一行（连同它后面几行）是不是一条写语句。
 *
 * ⚠️ **raw SQL 可以写成多行**（2026-08-29 补，第七轮复核实测出来的）：
 *     await tx.$executeRaw`
 *       UPDATE containers
 *       SET updated_at = NOW()
 *       WHERE ...`;
 * 上一版只在**同一行**里找 SQL 关键字，这种写法一个都抓不到，7 项照样全绿。
 * 现在从 `tx.$executeRaw` 那一行起往后看到反引号收尾为止。
 *
 * ⚠️ 小心别把 `SELECT ... FOR UPDATE` 当成写 —— 它里面也有 UPDATE 这个词，
 * 所以匹配的是 `UPDATE 表名 SET` 这种完整形状。
 */
function isWriteAt(lines: string[], i: number): boolean {
  const line = lines[i];
  if (WRITE_RE.test(line)) return true;
  if (!RAW_WRITE_RE.test(line)) return false;
  // 把这条 raw 语句的整段拼起来（最多往后看 12 行，够长了）
  let chunk = line;
  for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
    chunk += "\n" + lines[j];
    if (/`\s*;?\s*$/.test(lines[j].trim())) break;
  }
  return RAW_WRITE_SQL_RE.test(chunk);
}

/**
 * ② 这一行的锁是不是**根本走不到**的（2026-08-29 补）。
 * 复核变异把真锁改成 `if (false) await ... FOR UPDATE`，7 项照样全绿。
 * ⚠️ 只认写死的假条件 —— 正常的条件锁（比如「有父单才锁父单」）必须放行，
 * 不能一刀切禁掉带条件的锁。
 * ⚠️ 这只是个补丁：**扫源码判断不了可达性**，真正的守卫是行为测试。
 */
function isDeadLine(line: string): boolean {
  return /\bif\s*\(\s*(false|0|!true|1\s*===\s*2|1\s*==\s*2)\s*\)/.test(line);
}

/**
 * ⚠️⚠️ **加锁语句上不许挂任何条件**（2026-08-29 第十一轮改，换了思路）。
 *
 * 我前几轮一直在**枚举写死的假条件**：`false` → 加 `0`/`!true` → 加 `1===2`。
 * 复核每一轮都能找出新写法，这一轮是 `if (Boolean(0))`。
 * **枚举是追不完的** —— `if (!!0)`、`if ([].length)`、`if (someConst)`…… 无穷无尽。
 *
 * 换个思路：不去判断「这个条件是真是假」（静态分析做不到），
 * 而是要求**加锁那一行本身不许带 if**。
 * 锁本来就该无条件拿 —— 「有父单才锁父单」那种真实的条件锁，
 * 写成 `if (x) { 换行 await ...FOR UPDATE }` 的**块**形式即可，
 * 那种由下面 `deadBlockEnd` 按大括号配对处理，不受这条影响。
 *
 * 于是「同一行里 if + 锁」一律当成可疑：要么是死代码，
 * 要么是有人图省事写了单行条件锁 —— 后者也该改成块形式，方便下一个人看懂。
 */
function isConditionalLockLine(line: string): boolean {
  const t = line.trim();
  if (!/FOR UPDATE/.test(t) && !Object.keys(LOCK_HELPERS).some((h) => t.includes(`${h}(`))) {
    return false;
  }
  // 同一行里既有 if( 又有锁，而且 if 没有以 { 收尾（那是块形式，另算）
  return /\bif\s*\(/.test(t) && !/\{\s*$/.test(t);
}

/**
 * 从第 i 行开始，往后**整个死代码块**的范围（左闭右开）。
 *
 * ⚠️⚠️ 上一版 `isDeadLine()` **只看当前那一行**，于是
 *     if (false) {
 *       await tx.$queryRaw`... FOR UPDATE`;   ← 这一行不含 if(false)，被当成真锁
 *     }
 * 整个绕过去了 —— **复核连着两轮报同一件事，我一直只补了单行写法。**
 * 现在遇到 `if (写死的假条件) {` 就按大括号配对把整块跳掉。
 * 单行写法（`if (false) await ...`）仍由上面那个函数管。
 */
function deadBlockEnd(lines: string[], i: number): number {
  if (!isDeadLine(lines[i])) return i + 1;
  // 单行形式：这一行里就写完了，跳一行
  if (!/\{\s*$/.test(lines[i])) return i + 1;
  let depth = 0;
  for (let j = i; j < lines.length; j += 1) {
    const t = lines[j];
    // 粗略配对就够了：这里只求「别把死代码里的锁算进去」，不求完美解析
    depth += (t.match(/\{/g) ?? []).length;
    depth -= (t.match(/\}/g) ?? []).length;
    if (depth <= 0 && j > i) return j + 1;
  }
  return lines.length;
}
const RAW_LOCK_RE = /FROM\s+(\w+)\s+WHERE[\s\S]*FOR UPDATE|FOR UPDATE/;

interface TxBlock {
  file: string;
  route: string;
  line: number;
  locks: string[];
  firstLockLine: number | null;
  firstWriteLine: number | null;
}

function scanFile(file: string): TxBlock[] {
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const blocks: TxBlock[] = [];
  let route = "(文件顶层)";
  let i = 0;
  while (i < lines.length) {
    const routeMatch = /app\.(post|get|delete)\("([^"]+)"/.exec(lines[i]);
    if (routeMatch) route = routeMatch[2];
    if (lines[i].includes("$transaction")) {
      const start = i;
      const locks: string[] = [];
      let firstLockLine: number | null = null;
      let firstWriteLine: number | null = null;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (l.includes("$transaction") || /app\.(post|get|delete)\("/.test(l)) break;
        /**
         * ⚠️ **注释行要跳过**（2026-08-29 修）。
         * 第一版没跳，结果我在源码里写的那句
         *   「以后判断锁序不能只看 FOR UPDATE 的位置」
         * 被当成了一把真锁 —— 把加锁语句删掉做变异，测试照样全绿。
         * 我自己的注释把我自己的测试骗了，跟这个脚本要防的是同一类毛病。
         */
        const trimmed = l.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
          j += 1;
          continue;
        }
        /**
         * ⚠️ 只记**第一次**拿到这张表的锁（2026-08-29 改）。
         *
         * 原来是「跟上一条不同就 push」，于是
         *   运单 → 柜内记录 → 运单（第二次是同一个事务里再锁一次父单）
         * 会被当成「运单排在柜内记录后面」而误报。
         * 同一个事务里重复锁同一行/同一张表是免费的，
         * 决定会不会死锁的是**第一次**拿锁的先后。
         */
        // 写死走不到的分支，**整块**都不算数（不只是 if 那一行）
        if (isDeadLine(l)) { j = deadBlockEnd(lines, j); continue; }
        // 同一行里 if + 锁：不判断条件真假（判不了），一律不算数
        if (isConditionalLockLine(l)) { j += 1; continue; }
        const helper = Object.keys(LOCK_HELPERS).find((h) => l.includes(`${h}(`));
        if (helper) {
          for (const t of LOCK_HELPERS[helper]) if (!locks.includes(t)) locks.push(t);
          if (firstLockLine === null) firstLockLine = j + 1;
        } else if (RAW_LOCK_RE.test(l) && l.includes("FOR UPDATE")) {
          const t = /FROM\s+(\w+)/.exec(l)?.[1];
          if (t && !locks.includes(t)) locks.push(t);
          if (firstLockLine === null) firstLockLine = j + 1;
        }
        if (firstWriteLine === null && isWriteAt(lines, j)) firstWriteLine = j + 1;
        // 写 = 拿锁（见 MODEL_TABLE 上面那段），同样只记第一次
        for (const [model, table] of Object.entries(MODEL_TABLE)) {
          const re = new RegExp(`\\btx\\.${model}\\.(create|update|updateMany|delete|deleteMany|upsert|createMany)\\b`);
          if (re.test(l) && !locks.includes(table)) locks.push(table);
        }
        j += 1;
      }
      blocks.push({ file, route, line: start + 1, locks, firstLockLine, firstWriteLine });
      i = j;
      continue;
    }
    i += 1;
  }
  return blocks;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const allBlocks = walk(ROOT).flatMap(scanFile).filter((b) => b.firstWriteLine !== null);

const failures: string[] = [];
function check(name: string, body: () => void): void {
  try {
    body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

const rel = (f: string): string => path.relative(ROOT, f);

console.log("加锁顺序");

/**
 * 不需要加锁的事务：只往里插全新的行、不依赖「先读再判」的。
 * ⚠️ 往这张表里加东西前先问一句：这个事务有没有「读一个值 → 拿它做决定 → 再写」？
 * 有的话就必须加锁，不能放进白名单。
 */
/**
 * ⚠️ **按「文件 + 路由」匹配，不许写行号**（2026-08-29 改）。
 * 上一版写的是 `whr-consolidation/routes.ts:161`，我在同文件上面加了两行 import，
 * 行号漂到 174，白名单当场失效、测试变红。
 * 同一个坑我刚在 WRITE_WITHOUT_LOCK_OK 上修过一次，这张表漏了。
 * 按路由匹配：代码挪位置不受影响；真换了一处地方漏锁，路由对不上照样会红。
 */
const NO_LOCK_NEEDED: Array<[string, string]> = [
  ["client-addresses/routes.ts", "新建收货地址：纯插入一行新数据，不依赖任何已有状态"],
  ["/admin/whr-consolidation/plans", "新建拼柜计划：纯插入，计划这时候还不存在"],
  /*
   * 2026-09-16：原来这里豁免了 item-cargo-type（「故意不重算金额」）。
   * 那条路现在会重算没付款的单的金额，而且第一句就是 lockPlanAliveByPrealert，
   * 不需要豁免了 —— 删掉，免得以后它真漏了锁也被这一条吃掉。
   */
];

/**
 * 第 7 项的豁免：**新建**一行热表数据不需要先锁它（那行还不存在，锁不到）。
 * ⚠️ 只放「纯 create」，凡是 update / delete 一律不许进这张表 ——
 * 2026-08-31 起这条不再靠人守：违规文案带上了写库方法，
 * 豁免串写死「create了」，同一条路由里冒出 update / delete 会自动变红。
 */
const WRITE_WITHOUT_LOCK_OK: string[] = [
  /**
   * 建派送单：`adminLastmileOrder.create` 插的是**全新的一行**，那行还不存在、锁不到。
   * 这个事务已经先用 lockShipmentsChildrenFirst 锁完了全部运单，并发那面是护住的。
   *
   * ⚠️ 这里**故意不写行号**（2026-08-29 改）：上一版写的是
   * `"admin-ops/routes.ts:663"`，我在同一个文件上面插了几行注释，
   * 行号就漂到 668，豁免当场失效、测试变红。
   * 豁免按「文件 + 路由 + 动词 + 表名」匹配，代码挪位置不受影响；
   * 而真要是**换了一处**地方漏锁，路由或表名就对不上，照样会红。
   */
  "admin-ops/routes.ts:%d /admin/lastmile/orders（create了 admin_lastmile_orders",
  /**
   * 客户建预报单（2026-08-31 排查报告第 5 条改成了单事务）：
   * order.create / shipment.create 插的都是**全新的行**，那行还不存在、锁不到；
   * 并发那面靠 generatePrealertNo 的 advisory 取号锁排队（见 LOCK_HELPERS）。
   * ⚠️ 豁免串写死「create了」（2026-08-31 复查改）：这条路哪天改成
   * update / delete，动词对不上、豁免自动失效变红，不用指望人记得来删。
   * （createMany 也对不上 —— 真改成那种写法就来这里重审一次。）
   */
  "orders/routes.ts:%d /client/prealerts（create了 orders",
  "orders/routes.ts:%d /client/prealerts（create了 shipments",
];

/**
 * 已知没加锁、但还没修的路径。
 *
 * **2026-08-29 已经空了** —— 原来挂在这里的三条
 *   · /admin/orders/delete    删订单
 *   · /admin/lastmile/status  签收
 *   · /admin/lastmile/orders  删派送单
 * 当天全部补上了锁（第六轮复核点名要修签收那条）。
 *
 * 这张表**只许变短、不许变长**（见第 5 项）：
 * 往里加东西 = 承认自己写了一条没锁的写库路径，要老板拍板，不许偷偷放行。
 * 新写的接口漏了锁会立刻被第 1 项逮住。
 */
const KNOWN_UNFIXED: string[] = [];

check("1) 每个会写数据的事务，第一条写语句都排在第一把锁后面", () => {
  /**
   * 这一项就是复核抓到我那次的：管理员强改先删改产品行、再加锁 ——
   * 正则看「FOR UPDATE 的先后」是看不出来的，必须比「第一次写」和「第一把锁」的行号。
   */
  const bad = allBlocks
    .filter((b) => b.firstLockLine === null || b.firstWriteLine! < b.firstLockLine)
    .filter((b) => !NO_LOCK_NEEDED.some(([key]) => `${rel(b.file)}:${b.line} ${b.route}`.includes(key)))
    .filter((b) => !KNOWN_UNFIXED.includes(`${rel(b.file)}:${b.line}`))
    .map((b) => `${rel(b.file)}:${b.line} ${b.route}（首次写 ${b.firstWriteLine}，首把锁 ${b.firstLockLine ?? "无"}）`);
  assert.deepEqual(bad, [], "下面这些事务在拿到锁之前就写数据了，锁等于白加：\n     " + bad.join("\n     "));
});

check("2) 集货：所有事务都按【任务 → 预报单】的顺序加锁", () => {
  const seen = allBlocks
    .filter((b) => b.file.includes("/consolidation/") && !b.file.includes("whr-"))
    .map((b) => ({ b, seq: b.locks.filter((t) => t.startsWith("consolidation_")) }))
    .filter((x) => x.seq.length > 1);
  const bad = seen
    .filter((x) => {
      const t = x.seq.indexOf("consolidation_tasks");
      const p = x.seq.indexOf("consolidation_prealerts");
      return t >= 0 && p >= 0 && p < t;
    })
    .map((x) => `${rel(x.b.file)}:${x.b.line} ${x.b.route}（${x.seq.join(" → ")}）`);
  assert.deepEqual(bad, [], "下面这些先锁预报单后锁任务，跟别处反着，会死锁：\n     " + bad.join("\n     "));
});

check("3) 柜子：所有事务都按【柜 → 运单 → 柜内记录】的顺序加锁", () => {
  /**
   * ⚠️ 顺序 2026-08-29 改过，别看到旧注释就改回去。
   *
   * 原来声明的是【柜 → 柜内记录 → 运单】，但**装柜那条路做不到** ——
   * 它插的是一行还不存在的柜内记录，没法提前锁。
   * 于是装柜实际走的是【柜 → 运单 → 柜内记录】，卸柜走【柜 → 柜内记录 → 运单】，
   * 第七轮复核在本地库开两个连接实测，PostgreSQL 报 `deadlock detected`。
   *
   * ⚠️ 而这一项当时是**绿的** —— 因为装柜只 `create` 柜内记录、不发 FOR UPDATE，
   * 扫描器看到的 locks 只有 [containers, shipments]，不违反任何顺序。
   * **「没发 FOR UPDATE」不等于「没拿锁」**：唯一索引 `(container_id, shipment_id)`
   * 冲突时，insert 照样要等对方那一行。这是这个扫描器最根本的一条局限，
   * 下面第 8 项就是专门盯它的。
   */
  const ORDER = ["containers", "shipments", "shipment_container_items"];
  const bad = allBlocks
    .filter((b) => b.file.includes("/containers/") || b.file.includes("/loading-manifests/"))
    .map((b) => ({ b, seq: b.locks.filter((t) => ORDER.includes(t)) }))
    .filter((x) => x.seq.length > 1)
    .filter((x) => {
      const idx = x.seq.map((t) => ORDER.indexOf(t));
      return idx.some((v, i) => i > 0 && v < idx[i - 1]);
    })
    .map((x) => `${rel(x.b.file)}:${x.b.line} ${x.b.route}（${x.seq.join(" → ")}）`);
  assert.deepEqual(bad, [], "下面这些柜子相关事务的锁序跟别处反着，会死锁：\n     " + bad.join("\n     "));
});

check("6) 循环里取锁的，必须锁在**排过序**的清单上", () => {
  /**
   * 独立变异实测（2026-08-29）：把撤销柜子那处的父单锁改成反序，**5 项照样全绿** ——
   * 因为前面几项只看「锁了哪几张表、谁先谁后」，看不见**同一张表内部**的取锁顺序。
   *
   * 一批运单 / 一批父单，两个事务一个 A→B、一个 B→A，就是最经典的反向等待。
   * 所以规矩定死：**取锁的循环，迭代的那个表达式里必须看得见 `.sort(`**。
   * 不接受「SQL 里 orderBy 了所以是有序的」—— 那种得翻到别处才看得出来，
   * 下一个改代码的人看不见，等于没有。要排序就排在眼前这一行。
   */
  const bad: string[] = [];
  let lockLoopsSeen = 0;
  for (const file of walk(ROOT)) {
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      /**
       * ⚠️ 这里第一版写的是 `of\s+([^)]+)\)` —— 迭代的表达式里只要有一对括号
       * （`[...ids].sort()` 就是）就匹配不上，**一个循环都没扫到，照样全绿**。
       * 我自己新写的检查，自己又假绿了一次。所以下面还加了「至少要扫到几个」的自检。
       * 用贪婪的 `(.+)` 吃到行尾最后一个 `)`。
       */
      const m = /for\s*\(\s*const\s+\w+\s+of\s+(.+)\)\s*\{\s*$/.exec(lines[i]);
      if (!m) continue;
      // 往下看几行：这个循环体里有没有取锁
      let locks = false;
      for (let j = i + 1; j < Math.min(i + 7, lines.length); j += 1) {
        const t = lines[j].trim();
        if (t.startsWith("}")) break;
        if (t.startsWith("*") || t.startsWith("//")) continue;
        if (t.includes("FOR UPDATE") || Object.keys(LOCK_HELPERS).some((h) => t.includes(`${h}(`))) {
          locks = true;
          break;
        }
      }
      if (!locks) continue;
      lockLoopsSeen += 1;
      /**
       * ⚠️ 必须**以 `.sort(...)` 结尾**（2026-08-29 改）。
       * 上一版只要求「出现过 .sort(」，复核变异写成 `.sort().reverse()`
       * 照样全绿 —— 排完又倒过来，等于没排。
       * 排序后面再接任何东西都可能把顺序改掉，一律不认。
       */
      if (/\.sort\([^)]*\)\s*$/.test(m[1].trim())) continue;
      bad.push(`${rel(file)}:${i + 1}  for (... of ${m[1].trim()})`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    "下面这些循环在给一批行加锁，但迭代的清单没排序 —— 两个事务顺序相反就死锁：\n     " +
      bad.join("\n     "),
  );
  // ⚠️ 自检：一个都没扫到就说明正则又写窄了，上面那个 deepEqual 的绿灯不作数
  /**
   * ⚠️ 阈值 2026-08-29 从 6 调到 4：三处「按运单号逐个同步父单」的循环
   * 被收进了 lockAndSyncParents，**是有意减少的**，不是正则失灵。
   * 以后这个数**只该因为又抽了共用函数而变小**；
   * 无缘无故变小就说明正则又写窄了，这一项的绿灯不作数。
   */
  assert.ok(
    lockLoopsSeen >= 4,
    `只扫到 ${lockLoopsSeen} 个「循环里取锁」的地方，比预期少 —— 正则可能又写窄了，这一项的绿灯不作数`,
  );
});

/**
 * 「写哪张表，就必须先锁哪张表」—— 只管下面这几张**真出过事**的热表。
 * 别的表大多是子表（轨迹、产品行、图片），锁住父行就够了，全都要求反而全是噪音。
 */
const HOT_TABLES: Record<string, string> = {
  shipment: "shipments",
  container: "containers",
  order: "orders",
  adminLastmileOrder: "admin_lastmile_orders",
  /**
   * ⚠️ `shipmentContainerItem` **故意不放进来**（2026-08-29 想清楚的）。
   * 第七轮复核建议加上它，我加了之后扫出 5 处 —— 逐个读过，**5 处都是好的**：
   * 它们都握着上游的柜锁或运单锁，只是没有单独去锁 item 那一行。
   * 柜内记录的风险不在「有没有锁它」，而在「**什么时候**碰它」，
   * 那是第 3 项管的顺序问题。放进这里只会得到 5 条噪音，
   * 噪音多了这一项就没人看了。
   */
};

check("7) 改了运单/柜子/订单/派送单的事务，必须先锁住同一张表", () => {
  /**
   * 独立变异实测（2026-08-29）：把「推进柜子状态」里新加的**逐票运单锁**整段删掉，
   * **5 项照样全绿** —— 因为前面几项只查「已有的锁排得对不对」，
   * 不查「该有的锁在不在」。删掉一把锁反而没人管，这是最要命的一种假绿。
   *
   * 这一项反过来查：事务里 `tx.shipment.update(...)` 了，
   * 那它就必须在**这条写语句之前**锁过 shipments。
   */
  const bad: string[] = [];
  for (const file of walk(ROOT)) {
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    for (const b of scanFile(file)) {
      // 这个事务块的范围：从 b.line 到下一个块（scanFile 已经切好，这里重扫一遍拿写的表）
      let j = b.line; // b.line 是 1-based 的 $transaction 那一行
      const held = new Set<string>();
      while (j < lines.length) {
        const l = lines[j];
        if (l.includes("$transaction") || /app\.(post|get|delete)\("/.test(l)) break;
        const t = l.trim();
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) { j += 1; continue; }
        /**
         * ⚠️ 死代码和「同一行 if + 锁」这两种，**第 7 项也要跳**
         * （2026-08-29 第十一轮补）。
         * 我上一版只在 scanFile 里跳了，第 7 项有**自己一套扫描**、没跟着改 ——
         * 于是 `if (Boolean(0)) await ...FOR UPDATE` 在第 7 项眼里
         * 仍然算「锁过了」，7 种假条件全部假绿。
         * **同一个规则写在两处，改一处就会漏。**
         */
        if (isDeadLine(l)) { j = deadBlockEnd(lines, j); continue; }
        if (isConditionalLockLine(l)) { j += 1; continue; }
        // 先记下这一行拿到的锁
        const helper = Object.keys(LOCK_HELPERS).find((h) => l.includes(`${h}(`));
        if (helper) for (const tb of LOCK_HELPERS[helper]) held.add(tb);
        if (l.includes("FOR UPDATE")) {
          const tb = /FROM\s+(\w+)/.exec(l)?.[1];
          if (tb) held.add(tb);
        }
        /**
         * 再看这一行有没有写热表。
         * ⚠️ 违规文案要带上**写库方法**（2026-08-31 复查改）：
         * 原来一律写「改了 orders」，create / update / delete 分不出来，
         * 豁免串按「文件 + 路由 + 表名」一吃就是一整条路由 ——
         * 以后有人在被豁免的事务里加一条没锁行的 tx.order.update，
         * 也被同一条豁免吃掉，绿灯全靠人记得来删豁免。
         * 现在动词写进文案，豁免串写死成「create了 xxx」：
         * update / delete 一出现动词对不上，豁免失效、自动变红。
         */
        for (const [model, table] of Object.entries(HOT_TABLES)) {
          const re = new RegExp(`\\btx\\.${model}\\.(create|update|updateMany|delete|deleteMany|upsert|createMany)\\b`);
          const wm = re.exec(l);
          if (wm && !held.has(table)) {
            bad.push(`${rel(file)}:${j + 1} ${b.route}（${wm[1]}了 ${table}，但之前没锁过它）`);
          }
        }
        j += 1;
      }
    }
  }
  /** 豁免比对时把行号抹掉，代码挪位置不影响 */
  const stripLine = (t: string): string => t.replace(/\.ts:\d+ /, ".ts:%d ");
  const filtered = [...new Set(bad)].filter(
    (line) => !WRITE_WITHOUT_LOCK_OK.some((k) => stripLine(line).includes(k)),
  );
  assert.deepEqual(
    filtered,
    [],
    "下面这些地方改了热表却没先锁住它：\n     " + filtered.join("\n     "),
  );
});

/**
 * ⚠️⚠️ 原来这里是一张「审阅登记表」BULK_SHIPMENT_LOCKS_REVIEWED，
 * 我给三处批量锁各写了一条「这批 id 里不会同时出现父单和它的子单」的理由。
 *
 * **第八轮复核把三条理由全推翻了**：
 *   · 建派送单 —— 尾端页面取候选运单走 `/staff/shipments?all=1`，
 *     后端 `all=1` 就是**明确不过滤父子**（shipments/routes.ts:427-429）。
 *     测试库里有 5 组父子单同时可派送，双连接实测出真死锁。
 *   · 柜子那两条 —— 老的 `/admin/containers/load` 当时**根本不检查父子关系**，
 *     父单和它的子单可以分别装进同一个柜（这条接口 2026-08-31 已删，
 *     见 containers/routes.ts 里的注释；这里留着当「人工推理靠不住」的证据）。
 *
 * 三条理由，三条全错。**靠人工推理的白名单，可靠性就等于那个人的推理。**
 * 所以整张表删掉，换成一条不需要推理的规矩：
 *   **批量锁运单只许走 lockShipmentsChildrenFirst()**，
 *   由它在锁之前真去查一遍父子关系。
 */

check("8) 批量锁运单只许走 lockShipmentsChildrenFirst，不许自己拼", () => {
  /**
   * ⚠️⚠️ 这一项换过做法（2026-08-29 第八轮），别改回去。
   *
   * 第七轮我发现「删订单把父单子单混排」会死锁，于是加了这一项，
   * 靠「迭代变量名里有没有 child/parent」判断。
   * 那样有两个毛病：① 靠命名，改个名就绕过去了；
   * ② 剩下的只能挂进人工审阅表 —— 而我写的三条理由第八轮被证明**全是错的**。
   *
   * 现在的规矩不需要任何推理：**凡是一次锁一批运单的，只许调共用函数**，
   * 由它去查父子关系、分两层、层内排序。
   * 于是这一项只要查一件事：还有没有人自己拼这个循环。
   */
  const bad: string[] = [];
  for (const file of walk(ROOT)) {
    if (file.endsWith("lock-shipments.ts")) continue; // 共用函数自己就是那份实现
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const t = lines[i].trim();
      if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) continue;
      const m = /for\s*\(\s*const\s+\w+\s+of\s+(.+)\)\s*\{\s*$/.exec(lines[i]);
      if (!m) continue;
      /**
       * 这个循环里锁的是 shipments 吗。
       * ⚠️ 两种都要认（2026-08-29 补）：
       *   ① 字面写着 `FROM shipments ... FOR UPDATE`
       *   ② 调了一个**登记过会锁 shipments 的 helper**
       * 只认①的话，「循环里逐个调 syncParentStatusFromChildren」这种
       * 完全抓不到 —— 而那正是「父单按运单号排」那个 bug 的形状。
       */
      const helpersLockingShipments = Object.entries(LOCK_HELPERS)
        .filter(([, tables]) => tables.includes("shipments"))
        .map(([name]) => name)
        // 共用入口自己不算（它就是正确答案）
        .filter((n) => n !== "lockAndSyncParents");
      let locksShipments = false;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j += 1) {
        const b = lines[j];
        if (b.includes("FROM shipments") && b.includes("FOR UPDATE")) { locksShipments = true; break; }
        if (helpersLockingShipments.some((h) => b.includes(`${h}(`))) { locksShipments = true; break; }
        if (b.trim().startsWith("}")) break;
      }
      if (!locksShipments) continue;
      /**
       * 放行「只锁一票货」的循环（比如按单号逐个同步父单）——
       * 那种一次就一行，不存在批内顺序问题。
       * 判断依据：迭代的是不是一个**复数命名的 id 清单**。
       */
      if (!/Ids|ids|List|Nos/.test(m[1])) continue;
      bad.push(`${rel(file)}:${i + 1}  for (... of ${m[1].trim()})`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    "下面这些地方自己拼了「批量锁运单」的循环，请改用 lockShipmentsChildrenFirst()：\n     " +
      bad.join("\n     "),
  );
});

check("9) 共用的批量锁函数本身要守住三条：查父子、分两层、层内排序", () => {
  /**
   * 上一项只保证「大家都调它」。这一项盯**它自己**别被改坏 ——
   * 全系统的锁序现在都押在这一个函数上，它错了就是全错。
   */
  const fs2 = require("node:fs") as typeof import("node:fs");
  const src = fs2.readFileSync(path.join(ROOT, "shipments", "lock-shipments.ts"), "utf-8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
  /**
   * ⚠️ 光查「源码里有没有 parentTrackingNo 这个词」是不够的（2026-08-29 修）。
   * 变异「childIds = rows.map(全部)，parentIds = []」把分层拆掉了，
   * 而 `parentTrackingNo` 在上面那句 findMany 的 select 里还在，照样绿。
   * 必须查**分层那两句的具体形状**。
   */
  assert.ok(/parentTrackingNo/.test(src), "不查父子关系了 —— 那分层就是瞎分的");
  /**
   * ⚠️ 按**行**判断，不写一整条正则（2026-08-29 修）。
   * 第一版写的是 `rows\.filter\([^)]*=>...`，而真实代码是
   *   `rows.filter((r: any) => r.parentTrackingNo)`
   * —— `[^)]*` 跨不过 `(r: any)` 里那个右括号，于是干净的代码也被判红。
   * **写断言前先把真实那一行打出来看一眼**，别照脑子里的形状写正则。
   */
  const childLine = src.split("\n").find((l) => /const\s+childIds\s*=/.test(l)) ?? "";
  const parentLine = src.split("\n").find((l) => /const\s+parentIds\s*=/.test(l)) ?? "";
  assert.ok(
    /filter/.test(childLine) && /(?<!!)r\.parentTrackingNo/.test(childLine),
    `childIds 不再是「有父单的那些」了 —— 分层被拆掉，等于回到一锅端：${childLine.trim()}`,
  );
  assert.ok(
    /filter/.test(parentLine) && /!\s*r\.parentTrackingNo/.test(parentLine),
    `parentIds 不再是「没有父单的那些」了 —— 分层被拆掉：${parentLine.trim()}`,
  );
  assert.ok(
    /childIds[\s\S]{0,600}parentIds/.test(src),
    "子单必须排在父单前面（childIds 要出现在 parentIds 之前）",
  );
  // 两层都必须真的进了取锁循环，不能有一层被架空
  for (const layer of ["childIds", "parentIds"]) {
    assert.ok(
      new RegExp(`for \\(const sid of \\[\\.\\.\\.${layer}\\]\\.sort\\(\\)\\)`).test(src),
      `${layer} 那一层没有「按 id 排序逐个锁」的循环了`,
    );
  }

  /**
   * ⚠️ 这里原来是 `assert.equal(src.match(/\.sort\(\)/g).length, 2)` —— 数 `.sort()`
   * 出现几次。太脆：换成 `.sort((a,b)=>...)` 这种等价写法会误红，
   * 在别处随手加一句 `.sort()` 又能凑数。
   * 改成**逐个取锁循环**检查：文件里每一个会发 FOR UPDATE 的循环，
   * 迭代的表达式都必须以 `.sort()` 结尾。
   */
  const lockLoops = src
    .split("\n")
    .map((l, i) => ({ l, i }))
    .filter(({ i }) => {
      const body = src.split("\n").slice(i + 1, i + 3).join("\n");
      return /for\s*\(\s*const\s+\w+\s+of\s+/.test(src.split("\n")[i]) && /FOR UPDATE/.test(body);
    });
  assert.ok(lockLoops.length >= 3, `只找到 ${lockLoops.length} 个取锁循环，比预期少 —— 是不是有一层被删了`);
  for (const { l, i } of lockLoops) {
    const iter = /for\s*\(\s*const\s+\w+\s+of\s+(.+)\)\s*\{\s*$/.exec(l.trim())?.[1] ?? "";
    assert.ok(
      /\.sort\([^)]*\)\s*$/.test(iter.trim()),
      `第 ${i + 1} 行那个取锁循环迭代的清单没有以 .sort() 结尾：${iter}`,
    );
  }

  /**
   * ⚠️ **父单层必须按 id 排，不许按运单号排**（2026-08-29 补，这条差点又漏）。
   * 我这一轮抽出 lockShipmentsChildrenFirst 时父单层按 id 排，
   * 而系统里另外三处第二轮同步父单是按**运单号**排的
   * （syncParentStatusFromChildren 内部锁的是 `WHERE tracking_no = ...`）。
   * 同一批父单两把钥匙，照样能锁反 —— 测试库里 id 顺序和运单号顺序
   * 相反的父单对有 41 对。现在全系统父单层只认 id 一个键。
   */
  assert.ok(/lockParentsByTrackingNo/.test(src), "按运单号锁父单的换算函数没了");
  /**
   * ⚠️ 按**行**判断，别写整条正则（2026-08-29 —— 这个错我在同一个文件里
   * 刚记过一次「`[^)]*` 跨不过 `(r: any)` 里的括号」，转头又踩了一遍）。
   */
  const idSortLine = src
    .split("\n")
    .find((l) => /lockParentsByTrackingNo/.test(src) && /\.map\(/.test(l) && /r\.id/.test(l) && /\.sort\(\)/.test(l));
  assert.ok(
    idSortLine,
    "按运单号锁父单那条路没有换算成 id 再排序 —— 两把钥匙会锁反",
  );
  assert.ok(
    /既是子单又是父单|多层分柜/.test(src),
    "多层分柜（既是子单又是父单）的拦截没了 —— 那种数据会安安静静地去死锁",
  );
});

/**
 * 从 lines 里把 `async function 名字(...)` 的整个函数体切出来
 * （按大括号粗略配对，跟上面 deadBlockEnd 一个口径：只求够用，不求完美解析）。
 * 找不到定义返回 null。注意：只认**定义**，`await generateTaskNo(tx)` 这种调用不算。
 */
function functionBody(lines: string[], name: string): string[] | null {
  const defRe = new RegExp(`\\basync\\s+function\\s+${name}\\s*\\(`);
  for (let i = 0; i < lines.length; i += 1) {
    if (!defRe.test(lines[i])) continue;
    const body: string[] = [];
    let depth = 0;
    let started = false;
    for (let j = i; j < lines.length; j += 1) {
      body.push(lines[j]);
      depth += (lines[j].match(/\{/g) ?? []).length;
      depth -= (lines[j].match(/\}/g) ?? []).length;
      if (depth > 0) started = true;
      if (started && depth <= 0) return body;
    }
    return body;
  }
  return null;
}

/**
 * 函数体里有没有一句**真的会执行到**的 pg_advisory_xact_lock。
 * 口径跟上面 scanFile 完全一致：注释行不算、写死假条件的死块整块跳过、
 * 「同一行 if + 锁」不算数（真要条件锁就写成块形式，跟第 1/7 项一个规矩）。
 */
function hasLiveAdvisoryLock(body: string[]): boolean {
  let k = 0;
  while (k < body.length) {
    const t = body[k].trim();
    if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) { k += 1; continue; }
    if (isDeadLine(body[k])) { k = deadBlockEnd(body, k); continue; }
    if (body[k].includes("pg_advisory_xact_lock") && !(/\bif\s*\(/.test(t) && !/\{\s*$/.test(t))) {
      return true;
    }
    k += 1;
  }
  return false;
}

check("10) 登记成 advisory 锁的取号 helper，函数体里必须真有 pg_advisory_xact_lock", () => {
  /**
   * ⚠️ 2026-08-31 Codex 复核点的：LOCK_HELPERS 对取号 helper 是「见名给分」——
   * 把 generateTaskNo() 里的 pg_advisory_xact_lock 真删掉，前面 9 项照样全绿，
   * 因为登记表只看函数名，从来没人去函数体里核实那把锁还在不在。
   * 这一项补上：凡是登记成 advisory_ 假表名的 helper，
   * 去源文件里找到它的函数体，锁必须真的在、而且没被死条件包住。
   */
  const files = walk(ROOT);
  const advisoryHelpers = Object.entries(LOCK_HELPERS)
    .filter(([, tables]) => tables.every((t) => t.startsWith("advisory_")))
    .map(([name]) => name);
  assert.ok(
    advisoryHelpers.length >= 2,
    `只有 ${advisoryHelpers.length} 个登记成 advisory 的 helper，比预期少 —— 是不是有人把登记删了`,
  );
  for (const name of advisoryHelpers) {
    // 找**定义**（调用不算）：全模块里必须恰好一处 ——
    // 撞名的话登记表按名字给分，会给无锁的同名函数白发绿灯（见下面 generateTrackingNo）
    const defs = files
      .map((f) => ({ f, body: functionBody(fs.readFileSync(f, "utf-8").split("\n"), name) }))
      .filter((x) => x.body !== null);
    assert.equal(
      defs.length,
      1,
      `${name} 在模块里有 ${defs.length} 处定义 —— 登记表按名字给分，撞名就会发错绿灯，先改名再登记`,
    );
    assert.ok(
      hasLiveAdvisoryLock(defs[0].body!),
      `${rel(defs[0].f)} 里的 ${name}：helper 登记了锁但函数体里没有锁` +
        `（pg_advisory_xact_lock 被删了或被死条件包住了）`,
    );
  }
  /**
   * ⚠️ consolidation/routes.ts 的 generateTrackingNo（83002 那把锁）**故意不进 LOCK_HELPERS**
   * （2026-08-31 Codex 复核点名）：orders/routes.ts 里有个已废弃的同名 generateTrackingNo，
   * 不带 tx、没有锁。登记表是按「这一行出现了这个名字」给分的，
   * 把这个名字登进去，就等于给 orders 那个无锁同名函数白发绿灯。
   * 所以只能在这里点名核查 consolidation 这一个的函数体 —— 哪天两边改成不撞名了，
   * 再把它正常登进 LOCK_HELPERS、删掉这段特判。
   */
  const consolidationLines = fs
    .readFileSync(path.join(ROOT, "consolidation", "routes.ts"), "utf-8")
    .split("\n");
  const trackingBody = functionBody(consolidationLines, "generateTrackingNo");
  assert.ok(
    trackingBody,
    "consolidation/routes.ts 里找不到 generateTrackingNo 的定义了 —— 挪走的话把这段特判一起搬过去",
  );
  assert.ok(
    hasLiveAdvisoryLock(trackingBody!),
    "consolidation/routes.ts 的 generateTrackingNo：函数体里没有 pg_advisory_xact_lock" +
      "（83002 那把锁被删了或被死条件包住了）",
  );
});

check("4) 扫到的事务数量不能突然变少（防止我把正则写窄了自己骗自己）", () => {
  // 这个数字是 2026-08-29 实际扫出来的。以后加接口只会变多；
  // 变少说明正则漏掉了一批，那时候上面三项的「全绿」就不作数了。
  assert.ok(
    allBlocks.length >= 30,
    `只扫到 ${allBlocks.length} 个会写数据的事务，比预期少 —— 正则可能漏了一批，上面三项的绿灯不作数`,
  );
});

check("5) 「已知没加锁」那张表只许变短，不许变长", () => {
  const stillBroken = allBlocks
    .filter((b) => b.firstLockLine === null || b.firstWriteLine! < b.firstLockLine)
    .map((b) => `${rel(b.file)}:${b.line}`);
  const stale = KNOWN_UNFIXED.filter((k) => !stillBroken.includes(k));
  assert.deepEqual(
    stale,
    [],
    "这几条已经修好了，请把它们从 KNOWN_UNFIXED 里删掉，别让这张表越留越旧：\n     " + stale.join("\n     "),
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/10 项不通过：${failures.join("；")}`);
  process.exit(1);
}
console.log(`加锁顺序：10 项全部通过（扫了 ${allBlocks.length} 个会写数据的事务）`);
