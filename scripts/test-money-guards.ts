/**
 * ⚠️⚠️ **硬闸：这个脚本一次数据库都不许连。**
 * 「不小心连上测试库」这个坑我这几轮踩到第四次，靠记性不行。
 * 一旦哪个用例走到写库，会当场炸出 `Can't reach database server`。
 * ⚠️ 必须在 import 任何会创建 PrismaClient 的模块**之前**设。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";

/**
 * 集货那两套模块的「算钱数值」校验自测。
 *
 * 这一批是第九轮复核确认属实的 5 组 —— 它们的共同点是
 * **不会报错，只会安安静静算错钱**，比报 500 难发现得多：
 *
 *   1. 仓库版单价填 0.001 → `Decimal(10,2)` 存成 0.00 → **这一柜白送**
 *   2. 柜总方数没有上限   → 全系统唯一那道拦方数的闸失效
 *   3. 长宽高不限小数位   → 页面按 12.345 算方数、库里存 12.35，
 *                          客户拿计算器对不上账（复核实测 ¥850/方 差 ¥5.10）
 *   4. 普通版集货件数 `< 1` → **2.5 件**能存进 `Int` 列
 *   5. 普通版重量/长宽高   → 只查「填没填」，完全不查填的是什么
 *
 * ⚠️ 所有上限都是从**数据库字段定义**推出来的（Decimal(10,2) / Int），
 *    不是我编的业务数字。业务上限（比如「一个柜最多 200 方」）要老板给数。
 */
import assert from "node:assert/strict";
import {
  DECIMAL_10_2,
  DECIMAL_10_3,
  DECIMAL_10_6,
  DECIMAL_12_2,
  requireDecimal,
  checkTotalsWritable,
  requireDerivedWithinDecimal,
  requireUnitPrice,
} from "../apps/api/src/modules/core/decimal-guard";

type Handler = (req: any, res: any) => Promise<void> | void;

const failures: string[] = [];
function check(name: string, body: () => void): void {
  try { body(); console.log(`  ✅ ${name}`); }
  catch (error) {
    failures.push(name);
    const m = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${m.split("\n").join("\n     ")}`);
  }
}
async function checkAsync(name: string, body: () => Promise<void>): Promise<void> {
  try { await body(); console.log(`  ✅ ${name}`); }
  catch (error) {
    failures.push(name);
    const m = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${m.split("\n").join("\n     ")}`);
  }
}

async function loadRoutes(): Promise<Map<string, Handler>> {
  const routes = new Map<string, Handler>();
  const fakeApp = {
    get(p: string, h: Handler) { routes.set(`GET ${p}`, h); },
    post(p: string, h: Handler) { routes.set(`POST ${p}`, h); },
    delete(p: string, h: Handler) { routes.set(`DELETE ${p}`, h); },
    listen() {},
  };
  const whr = await import("../apps/api/src/modules/whr-consolidation/routes");
  const whrClient = await import("../apps/api/src/modules/whr-consolidation/client-routes");
  const cons = await import("../apps/api/src/modules/consolidation/routes");
  (whr as any).registerWhrConsolidationRoutes?.(fakeApp);
  (whrClient as any).registerWhrConsolidationClientRoutes?.(fakeApp);
  (cons as any).registerConsolidationRoutes?.(fakeApp);
  return routes;
}

async function callRoute(
  handler: Handler,
  auth: { userId: string; companyId: string; role: string; name: string },
  body: unknown,
): Promise<{ status: number; message: string }> {
  let status = 0;
  let payload: { message?: string } = {};
  const res: any = {
    status(code: number) { status = code; return res; },
    json(value: unknown) { payload = value as { message?: string }; },
  };
  await handler({ method: "POST", path: "", query: {}, headers: {}, body, auth }, res);
  return { status, message: payload.message ?? "" };
}

console.log("算钱数值校验");

// ══════════════ 第一部分：闸本身（纯函数） ══════════════

check("1) 单价 0.001 必须拦下 —— 它会被 Decimal(10,2) 存成 0.00，这一柜白送", () => {
  /**
   * ⚠️ 这是复核实测的那个值。原来的校验是「大于 0」，
   * 而 0.001 确实大于 0，所以一路放行、存进去变成 0.00。
   * 提示语里必须说清「为什么」—— 光说「必须大于 0」员工会以为系统坏了。
   */
  const msg = requireUnitPrice(0.001, "普货单价");
  assert.ok(msg, "0.001 被放行了");
  assert.ok(/0\.01/.test(msg!), `提示里没说清最小能填多少：${msg}`);
  assert.ok(/存成 0/.test(msg!), `提示里没说清后果：${msg}`);
});

check("2) 单价的边界两头都要对", () => {
  // ⚠️ 边界两头都测：0.01 放行、0.009 拦下（只测一边看不出差一位）
  assert.equal(requireUnitPrice(0.01, "单价"), null, "刚好 0.01 被误拦");
  assert.ok(requireUnitPrice(0.009, "单价"), "0.009 被放行");
  assert.equal(requireUnitPrice(850, "单价"), null, "正常单价 850 被误拦");
  assert.equal(requireUnitPrice(99999999.99, "单价"), null, "上限内的数被误拦");
  assert.ok(requireUnitPrice(100000000, "单价"), "超过 8 位整数没被拦");
});

check("3) 小数位数必须卡死 —— 多的位数被抹掉就是客户对不上账的原因", () => {
  /**
   * 复核实测：¥850/方 的柜子上，尺寸多一位小数造成 **¥5.10** 差价。
   * 页面按 12.345 算方数、库里按 12.35 存尺寸，客户拿计算器永远对不出来。
   */
  assert.ok(requireDecimal(12.345, "长(cm)", DECIMAL_10_2), "3 位小数被放行");
  assert.equal(requireDecimal(12.34, "长(cm)", DECIMAL_10_2), null, "2 位小数被误拦");
  assert.equal(requireDecimal(12, "长(cm)", DECIMAL_10_2), null, "整数被误拦");
  // 方数那一列是 Decimal(10,6)，规格不一样，别拿 2 位那套去卡它
  assert.equal(requireDecimal(1.928456, "方数", DECIMAL_10_6), null, "6 位小数的方数被误拦");
  assert.ok(requireDecimal(1.9284567, "方数", DECIMAL_10_6), "7 位小数被放行");
  assert.ok(requireDecimal(10000, "方数", DECIMAL_10_6), "方数超 4 位整数没被拦");
});

check("4) 布尔/数组/空值不许当成数字", () => {
  // ⚠️ Number(true) 是 1、Number([5]) 是 5，直接 Number() 挡不住
  for (const bad of [true, [5], null, undefined, "", "abc", {}]) {
    assert.ok(
      requireDecimal(bad, "单价", DECIMAL_10_2),
      `${JSON.stringify(bad)} 被当成合法数字放行了`,
    );
  }
  // 数字字符串是可以的（前端经常这么传）
  assert.equal(requireDecimal("12.5", "单价", DECIMAL_10_2), null, "数字字符串被误拦");
});


check("9) 派生值要按**舍入之后真正落库的值**判，两头都要卡", () => {
  /**
   * ⚠️ 复核实测把我上一版打穿了两头 —— 我只比了算出来的**原值**：
   *   · 下边界：0.01×0.01×0.01 cm × 1 件 = 1e-12 m³，原值确实 > 0 且 < 上限，
   *     放行；但 `Decimal(10,6)` 舍完**落库就是 0 方**。
   *     仓库版按「方数 × 单价」收费 → **0 方 = 白送**。「不能是 0」我又只修了表面。
   *   · 上边界：9999.9999996 原值 < 10000、放行；舍到 6 位变成 **10000** → 写库炸。
   */
  const tiny = (0.01 * 0.01 * 0.01) / 1_000_000;
  assert.ok(requireDerivedWithinDecimal(tiny, "方数", DECIMAL_10_6), "小到会被舍成 0 的方数被放行了");
  assert.ok(
    /变成 0/.test(requireDerivedWithinDecimal(tiny, "方数", DECIMAL_10_6)!),
    "提示语没说清「会被存成 0」这个后果",
  );
  assert.ok(requireDerivedWithinDecimal(9999.9999996, "方数", DECIMAL_10_6), "舍入后会溢出的值被放行了");
  // ⚠️ 边界两头都测：刚好能存下的不许被误拦
  assert.equal(requireDerivedWithinDecimal(0.000001, "方数", DECIMAL_10_6), null, "最小可存值被误拦");
  assert.equal(requireDerivedWithinDecimal(9999.999999, "方数", DECIMAL_10_6), null, "最大可存值被误拦");
  assert.equal(requireDerivedWithinDecimal(0, "方数", DECIMAL_10_6), null, "真正的 0 不该报错（那是「没有」不是「算错」）");
  assert.equal(requireDerivedWithinDecimal(1.928, "方数", DECIMAL_10_6), null, "正常方数被误拦");
});

check("10) 金额和跨行汇总也要卡 —— 每行都合法，加起来才爆", () => {
  /**
   * ⚠️ 复核报的：我前几轮只卡了**单行**和**单行的派生值**，跨行汇总一个都没卡。
   *   · 101 方 × 99999999.99 = 10099999998.99，
   *     而金额列是 `Decimal(12,2)`（最大 9999999999.99）→ **写库直接失败**
   *   · 两行各 15 亿 / 16 亿件 → 合计 31 亿，件数列是 `Int` → 溢出
   */
  const fee = 101 * 99999999.99;
  assert.ok(requireDerivedWithinDecimal(fee, "金额", DECIMAL_12_2), `金额 ${fee} 被放行`);
  assert.equal(requireDerivedWithinDecimal(9999999999.99, "金额", DECIMAL_12_2), null, "刚好到上限的金额被误拦");
  assert.equal(requireDerivedWithinDecimal(850 * 68, "金额", DECIMAL_12_2), null, "正常一柜的金额被误拦");
  // 客户总方数那一列是 Decimal(10,3)，规格跟单行方数不一样，别拿同一套去卡
  assert.equal(requireDerivedWithinDecimal(68.5, "总方数", DECIMAL_10_3), null, "正常总方数被误拦");
  assert.ok(requireDerivedWithinDecimal(10000000, "总方数", DECIMAL_10_3), "超上限的总方数被放行");
});


check("11) 数字字符串要被规范化 —— **真调共用校验函数看它改没改 p**", () => {
  /**
   * ⚠️ 上一版是扫源码找 `p.packageCount =` —— 复核实测把赋值包进 `if (false)`
   * 就绕过去了，11/11 照样全绿。**这是它第四轮报「源码扫描是假绿」。**
   *
   * 不再补正则。这个函数是导出的纯函数，直接调它、看它有没有真的改 p：
   * 扫源码只能证明「文件里出现过这几个字」，调用能证明「它真的做了」。
   */
  const { validateConsolidationProductRow } = require("../apps/api/src/modules/consolidation/routes") as {
    validateConsolidationProductRow?: (p: any, i: number) => string | null;
  };
  assert.ok(
    typeof validateConsolidationProductRow === "function",
    "consolidation/routes.ts 没有导出 validateConsolidationProductRow —— 导出它才测得到",
  );
  // 全部用字符串传进去（前端就是这么传的），看它有没有转成 number
  const row: any = {
    productName: "耳机", packageCount: "3", quantityPerBox: "10",
    unitWeightKg: "1.5", lengthCm: "30", widthCm: "20", heightCm: "10",
    material: "塑料", cargoValue: "1000",
  };
  const issue = validateConsolidationProductRow!(row, 0);
  assert.equal(issue, null, `合法的一行被拦了：${issue}`);
  for (const [f, want] of [
    ["packageCount", 3], ["quantityPerBox", 10], ["unitWeightKg", 1.5],
    ["lengthCm", 30], ["widthCm", 20], ["heightCm", 10],
  ] as Array<[string, number]>) {
    assert.strictEqual(
      row[f],
      want,
      `${f} 没有被规范化成数字（还是 ${JSON.stringify(row[f])}）—— 写库会拿到字符串，走到 Prisma 才报错`,
    );
  }
});



check("13) 闸用的舍入必须跟生产**一模一样**（两套算法 = 闸是错的）", () => {
  /**
   * ⚠️ 复核实测：我上一版闸里用 `toFixed(6)`，生产算方数用
   *   `Math.round((n + Number.EPSILON) * 1e6) / 1e6`
   * 两套算法在边界不一样：
   *   · 9999.9999995 → toFixed 得 9999.999999（放行），实际是 **10000** → 溢出
   *   · 0.0000005    → toFixed 得 0（误拦），实际存的是 0.000001
   * **闸和被闸的东西用两套算法，闸就是错的** —— 不是松就是紧。
   *
   * 这一项直接拿生产那个算法当基准比对，不是比字面写法。
   */
  const prodRound = (n: number, scale: number): number => {
    const f = 10 ** scale;
    return Math.round((n + Number.EPSILON) * f) / f;
  };
  // ⚠️ 这几个值是复核挑出来专门打两种算法差异的
  for (const v of [9999.9999995, 0.0000005, 0.0000004, 1.9284565, 0.125, 1.005, 2.675]) {
    const stored = prodRound(v, 6);
    const blocked = requireDerivedWithinDecimal(v, "方数", DECIMAL_10_6) !== null;
    const shouldBlock = stored === 0 ? v !== 0 : Math.abs(stored) >= 10000;
    assert.equal(
      blocked,
      shouldBlock,
      `${v}：生产算出来存的是 ${stored}，闸${blocked ? "拦了" : "放行"}，` +
        `但按生产的结果应该${shouldBlock ? "拦" : "放行"} —— 闸和生产用了两套舍入`,
    );
  }
});


check("14) ⚠️ 已知守不住的地方（诚实登记，不许假装有守卫）", () => {
  /**
   * ⚠️⚠️ 这一项不是守卫，是**一张诚实的清单**。
   *
   * 复核连着四轮说同一件事：「源码扫描测试只能证明源码里出现过某些文字，
   * 守不住真实行为」。他是对的。我这几轮的做法是：
   *   · 能抽成纯函数的 → 抽出来真调（第 11 项）
   *   · 能喂假 tx 的   → 喂假 tx 真调（第 12 项）
   *   · **两样都做不到的 → 老老实实登记在这里，不再写一条扫源码的检查
   *     去假装它被守住了**
   *
   * 写一条扫源码的检查，比什么都不写更糟 —— 它会让下一个人（包括我自己）
   * 以为这地方有守卫，然后放心去改。
   *
   * 下面这些是**真的没有自动化守卫**的地方，改它们必须人工复查：
   */
  const KNOWN_UNGUARDED = [
    "whr-consolidation/staff-routes.ts 仓库签收的金额闸 —— " +
      "它在路由事务里、拿不到 tx 之外的入口，要连数据库才测得到",
    "consolidation/routes.ts 三条删除路由的 verdict 接线 —— 同上",
    "apps/web 那几个 React 页面的提交逻辑 —— 要跑浏览器",
  ];
  /**
   * 这张表**只许变短，不许变长**：
   * 往里加一条 = 承认又多了一处没人守的地方，要老板知道。
   */
  assert.ok(
    KNOWN_UNGUARDED.length <= 3,
    `没有自动化守卫的地方从 3 处变成了 ${KNOWN_UNGUARDED.length} 处，请说明为什么`,
  );
  // 顺带确认签收那处的闸**现在**还在（改动时至少会被这一句提醒）
  const fs2 = require("node:fs") as typeof import("node:fs");
  const path2 = require("node:path") as typeof import("node:path");
  const src = fs2.readFileSync(
    path2.join(__dirname, "..", "apps", "api", "src", "modules", "whr-consolidation", "staff-routes.ts"),
    "utf-8",
  );
  assert.ok(
    /checkTotalsWritable\(\{ fees:/.test(src),
    "仓库签收那处的金额闸不见了 —— ⚠️ 但请注意这句只是**扫源码**，" +
      "包进 if(false) 它就抓不到。这地方真正靠的是人工复查。",
  );
});


check("15) 汇总闸不许把「合计很小」当成错 —— 那会让员工签不了收", () => {
  /**
   * ⚠️⚠️ **这是我上线前排查抓到的、自己引入的 bug。**
   *
   * 第十二轮我给汇总用了 `requireDerivedWithinDecimal`，那个函数带一条
   * 「舍完变成 0 就报错」—— 那条对**单行**是对的（客户把厘米填成米），
   * 对**合计**是错的：
   *   一个 **7×7×7 厘米的样品盒** = 0.000343 方，
   *   任务汇总方数落在 0~0.0005 之间 → 报 400 → **员工签不了收**，
   *   报错还是「请检查尺寸是不是填错了单位」这种听不懂的话。
   *
   * 为什么合计舍成 0 可以接受：**算钱不看这个汇总值** ——
   * 费用走 `calcFeeFromItems`，按每一行的方数 × 单价算。
   * 汇总只用来显示和算「柜子装了几成」。
   */
  const 样品盒 = (7 * 7 * 7) / 1_000_000; // 0.000343 方
  assert.equal(
    checkTotalsWritable({ volumes: [["总方数", 样品盒]] }),
    null,
    `7×7×7cm 的样品盒（${样品盒} 方）被汇总闸拦了 —— 员工签不了收`,
  );
  assert.equal(checkTotalsWritable({ volumes: [["总方数", 0.0003]] }), null, "极小的合计方数被拦");
  assert.equal(checkTotalsWritable({ volumes: [["总方数", 68.5]] }), null, "正常合计被拦");
  assert.equal(checkTotalsWritable({ fees: [["总金额", 850 * 68]] }), null, "正常合计金额被拦");
  // 但**溢出**照样要拦（那是真会写库失败的）
  assert.ok(checkTotalsWritable({ volumes: [["总方数", 10_000_000]] }), "溢出的合计方数被放行");
  assert.ok(checkTotalsWritable({ fees: [["总金额", 101 * 99999999.99]] }), "溢出的合计金额被放行");
  assert.ok(checkTotalsWritable({ counts: [["总件数", 3_100_000_000]] }), "溢出的合计件数被放行");

  /**
   * ⚠️ **单行那道闸不许跟着放宽** —— 「填错单位」必须在填的那一刻拦住。
   * 这一句是防止有人图省事把两处改成同一个函数。
   */
  assert.ok(
    requireDerivedWithinDecimal(样品盒 / 1000, "单行方数", DECIMAL_10_6),
    "单行方数小到会被舍成 0 时应该拦住（那是填错单位），这道闸被一起放宽了",
  );
});

// ══════════════ 第二部分：真调路由（证明闸接上了） ══════════════
// ⚠️ 只测「校验层」——合法数据往下走会连库，而本脚本禁了数据库。
//    所以正向对照一律用「数值合法但故意缺别的必填项」，停在连库之前那道闸。

async function main(): Promise<void> {
  const routes = await loadRoutes();
  const ADMIN = { userId: "u_admin", companyId: "c_test", role: "admin", name: "管理员", agentId: null };
  const CLIENT = { userId: "u_client", companyId: "c_test", role: "client", name: "客户", agentId: null };

  await checkAsync("12) 四个汇总点的溢出闸 —— **真调那几个 recalc 函数**（喂假 tx，不连库）", async () => {
    /**
     * ⚠️ 复核实测：把真实汇总闸移除，金额测试 11/11 照样全绿 ——
     * 因为我测的是**纯函数** `requireDerivedWithinDecimal`，
     * 没人问「它有没有被 recalc 那几个函数调用」。
     * 跟 lockShipmentsChildrenFirst 那次一样，用**假 tx** 就能真测到接线。
     */
    const { recalcCustomerTotals, recalcPrealertFee } = require(
      "../apps/api/src/modules/whr-consolidation/utils",
    ) as Record<string, any>;
  
    /** 假 tx：让汇总算出一个必定溢出的数，看函数抛不抛 */
    const txOverflowCounts: any = {
      whrConsolidationPrealert: {
        findMany: async () => [
          // 两行各 15 亿 / 16 亿件 —— 每行都合法，合计 31 亿超 Int
          { totalFee: 0, items: [{ volumeM3: 1, packageCount: 1_500_000_000 }] },
          { totalFee: 0, items: [{ volumeM3: 1, packageCount: 1_600_000_000 }] },
        ],
        findFirst: async () => null,
      },
      whrConsolidationPlanCustomer: { update: async () => { throw new Error("不该走到写库"); } },
    };
    await assert.rejects(
      () => recalcCustomerTotals("pc_1", txOverflowCounts),
      /总件数/,
      "客户总件数溢出没有被拦住 —— 会一路写到库里炸",
    );
  
    const txOverflowFee: any = {
      whrConsolidationPrealert: {
        findMany: async () => [
          { totalFee: 9_000_000_000, items: [{ volumeM3: 1, packageCount: 1 }] },
          { totalFee: 9_000_000_000, items: [{ volumeM3: 1, packageCount: 1 }] },
        ],
        findFirst: async () => null,
      },
      whrConsolidationPlanCustomer: { update: async () => { throw new Error("不该走到写库"); } },
    };
    await assert.rejects(
      () => recalcCustomerTotals("pc_1", txOverflowFee),
      /总金额/,
      "客户总金额溢出没有被拦住",
    );
  
    /**
   * ⚠️ 普通版那个 `recalcTaskTotals` 是**另一个汇总点**（第十二轮复核找出来的）。
   * 它不在 whr 那个文件里 —— 只测 whr 的话，这一处拿掉闸照样全绿。
   * 「N 个入口只修了 M 个」我犯过五六次，测试必须把每个入口都覆盖到。
   */
  const consolidation = require("../apps/api/src/modules/consolidation/routes") as Record<string, any>;
  assert.ok(
    typeof consolidation.recalcTaskTotals === "function",
    "consolidation/routes.ts 没有导出 recalcTaskTotals —— 导出它才测得到这个汇总点",
  );
  const txTaskOverflow: any = {
    consolidationPrealert: {
      findMany: async () => [
        // 两行各 11 亿件 —— 每行都合法，合计 22 亿超 Int
        { products: [{ packageCount: 1_100_000_000, volume: 1 }] },
        { products: [{ packageCount: 1_100_000_000, volume: 1 }] },
      ],
    },
    consolidationTask: { update: async () => { throw new Error("不该走到写库"); } },
  };
  await assert.rejects(
    () => consolidation.recalcTaskTotals("t_1", txTaskOverflow),
    /总件数/,
    "普通版任务的总件数溢出没有被拦住",
  );

  // 正常数字要放行、要真的写库
    let wrote: any = null;
    const txOk: any = {
      whrConsolidationPrealert: {
        findMany: async () => [{ totalFee: 850 * 68, items: [{ volumeM3: 1.928, packageCount: 7 }] }],
        findFirst: async () => null,
      },
      whrConsolidationPlanCustomer: { update: async (a: any) => { wrote = a.data; return a.data; } },
    };
    await recalcCustomerTotals("pc_1", txOk);
    assert.ok(wrote, "正常汇总没有写库 —— 闸把好数据也拦了");
    assert.equal(wrote.totalPackages, 7, `写进去的总件数不对：${wrote.totalPackages}`);
  });

  await checkAsync("5) 建柜接口：单价 0.001 和总方数超上限都要拦（真调路由）", async () => {
    const handler = routes.get("POST /admin/whr-consolidation/plans");
    assert.ok(handler, `没注册建柜路由，现有：${[...routes.keys()].slice(0, 8).join(", ")}`);
    /**
     * ⚠️ 字段名是从路由源码里抄的（routes.ts:91-100），不是我按印象写的。
     * 第一版我写成 `destination`，实际叫 `destinationTh`，
     * 结果所有用例都停在「目的地为必填」那道闸上 —— 测了个寂寞。
     */
    const base = {
      warehouse: "义乌", containerType: "40HQ", destinationTh: "曼谷",
      customers: [{ clientId: "u_client", unitPriceNormal: 850, unitPriceInspection: 900, unitPriceSensitive: 950 }],
    };
    // 单价 0.001
    const r1 = await callRoute(handler!, ADMIN, {
      ...base,
      customers: [{ clientId: "u_client", unitPriceNormal: 0.001, unitPriceInspection: 900, unitPriceSensitive: 950 }],
    });
    assert.equal(r1.status, 400, `单价 0.001 没被拦，拿到 ${r1.status}`);
    assert.ok(/单价/.test(r1.message), `拦是拦了，但不是单价那道闸：${r1.message}`);
    // 总方数超上限
    const r2 = await callRoute(handler!, ADMIN, { ...base, totalVolumeM3: 100000000 });
    assert.equal(r2.status, 400, `总方数 1 亿没被拦，拿到 ${r2.status}`);
    assert.ok(/总方数/.test(r2.message), `拦是拦了，但不是总方数那道闸：${r2.message}`);
    // 总方数 3 位小数
    const r3 = await callRoute(handler!, ADMIN, { ...base, totalVolumeM3: 68.123 });
    assert.equal(r3.status, 400, `总方数 3 位小数没被拦，拿到 ${r3.status}`);
  });

  await checkAsync("6) 普通版集货：2.5 件、负数重量、3 位小数尺寸都要拦（真调路由）", async () => {
    const handler = routes.get("POST /client/consolidation/prealerts");
    assert.ok(handler, `没注册普通版集货建单路由，现有：${[...routes.keys()].filter((k) => k.includes("consolidation")).slice(0, 10).join(", ")}`);
    const goodRow = {
      productName: "耳机", packageCount: 3, quantityPerBox: 10,
      unitWeightKg: 1.5, lengthCm: 30, widthCm: 20, heightCm: 10,
      material: "塑料", cargoValue: "1000",
    };
    const BAD: Array<[string, Record<string, unknown>]> = [
      ["件数 2.5", { packageCount: 2.5 }],
      ["件数 0", { packageCount: 0 }],
      ["件数 超上限", { packageCount: 2147483648 }],
      ["装箱数量 1.5", { quantityPerBox: 1.5 }],
      ["单件重量 -1", { unitWeightKg: -1 }],
      ["单件重量 0", { unitWeightKg: 0 }],
      ["单件重量 abc", { unitWeightKg: "abc" }],
      ["长 3 位小数", { lengthCm: 12.345 }],
      ["宽 0", { widthCm: 0 }],
      ["高 布尔", { heightCm: true }],
    ];
    for (const [label, patch] of BAD) {
      const r = await callRoute(handler!, CLIENT, {
        taskId: "t_1", mark: "XT001", products: [{ ...goodRow, ...patch }],
      });
      assert.equal(r.status, 400, `【${label}】没被拦，拿到 ${r.status}`);
      assert.ok(
        /产品行1/.test(r.message),
        `【${label}】是被 400 了，但报错不是产品行那道闸发的：${JSON.stringify(r.message)}`,
      );
    }
    /**
     * 正向对照：整行都合法时不许被数值闸拦。
     * ⚠️ 故意不给 taskId，让它停在别的必填项检查上（在连库之前）。
     */
    const good = await callRoute(handler!, CLIENT, { mark: "XT001", products: [goodRow] });
    assert.ok(
      !/产品行1/.test(good.message),
      `完全合法的一行被数值闸拦了：${good.message}`,
    );
  });


  await checkAsync("7) 另外三个改单价的入口也要拦（复核指出我只测了建柜）", async () => {
    /**
     * ⚠️ 复核实测：断开「修改客户单价」那道金额闸，我这个脚本 6/6 照样全绿 ——
     * 因为我只真调了「建柜」和「普通版建预报单」两个入口，
     * 剩下三个（改单价 / 新增客户 / 审核时改单价）一个都没覆盖。
     * 「五个入口只测了两个」跟「三个入口只修了一个」是同一类错。
     *
     * ⚠️ 字段名从路由源码里抄的（routes.ts:402/482/742），不是凭印象写的 ——
     * 上一版我把 `destinationTh` 写成 `destination`，所有用例都停在
     * 「目的地为必填」上，测了个寂寞。
     */
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["修改客户单价", "POST /admin/whr-consolidation/customers/price",
        { planId: "p_1", customerId: "u_client" }],
      ["新增客户", "POST /admin/whr-consolidation/customers/add",
        { planId: "p_1", clientId: "u_client" }],
      ["审核时改单价", "POST /admin/whr-consolidation/prealerts/review",
        { planId: "p_1", prealertId: "pa_1", action: "approve" }],
    ];
    for (const [label, key, base] of cases) {
      const handler = routes.get(key);
      assert.ok(handler, `没注册 ${key}（${label}）`);
      // 0.001 会被 Decimal(10,2) 存成 0.00
      const r1 = await callRoute(handler!, ADMIN, { ...base, unitPriceNormal: 0.001 });
      assert.equal(r1.status, 400, `【${label}】单价 0.001 没被拦，拿到 ${r1.status}`);
      assert.ok(/单价/.test(r1.message), `【${label}】拦是拦了，但不是单价闸：${r1.message}`);
      // 3 位小数
      const r2 = await callRoute(handler!, ADMIN, { ...base, unitPriceNormal: 12.345 });
      assert.equal(r2.status, 400, `【${label}】单价 3 位小数没被拦，拿到 ${r2.status}`);
      // 布尔
      const r3 = await callRoute(handler!, ADMIN, { ...base, unitPriceNormal: true });
      assert.equal(r3.status, 400, `【${label}】单价传布尔没被拦，拿到 ${r3.status}`);
    }
  });

  await checkAsync("8) 算出来的总重量/方数溢出也要拦（输入全合法的那种）", async () => {
    /**
     * ⚠️ 复核报的一条新的，也是最隐蔽的：**每个输入都合法，算出来的数爆掉**。
     *   · 单重 99999999.99 × 数量 2 = 199999999.98 →
     *     totalWeight 是 Decimal(10,2)，数据库实测 `numeric field overflow`
     *   · 1000×1000×1000cm × 10 件 = 10000 m³ →
     *     volume 是 Decimal(10,6)，最大只能存 9999.999999 → 裸 500
     * 只卡输入不卡输出，等于没卡。
     */
    const handler = routes.get("POST /client/consolidation/prealerts")!;
    const goodRow = {
      productName: "耳机", packageCount: 3, quantityPerBox: 10,
      unitWeightKg: 1.5, lengthCm: 30, widthCm: 20, heightCm: 10,
      material: "塑料", cargoValue: "1000",
    };
    // 总重量溢出：单重 99999999.99 × (件数 1 × 每箱 2) = 199999999.98
    const r1 = await callRoute(handler, CLIENT, {
      taskId: "t_1", mark: "XT001",
      products: [{ ...goodRow, unitWeightKg: 99999999.99, packageCount: 1, quantityPerBox: 2 }],
    });
    assert.equal(r1.status, 400, `总重量溢出没被拦，拿到 ${r1.status}`);
    assert.ok(/总重量/.test(r1.message), `拦是拦了，但不是总重量那道闸：${r1.message}`);

    // 方数溢出：1000×1000×1000cm ÷ 1e6 × 10 件 = 10000 m³
    const r2 = await callRoute(handler, CLIENT, {
      taskId: "t_1", mark: "XT001",
      products: [{ ...goodRow, lengthCm: 1000, widthCm: 1000, heightCm: 1000, packageCount: 10 }],
    });
    assert.equal(r2.status, 400, `方数溢出没被拦，拿到 ${r2.status}`);
    assert.ok(/体积|方数/.test(r2.message), `拦是拦了，但不是方数那道闸：${r2.message}`);

    // 正向对照：正常大小的货不许被误伤（30×20×10cm × 3 件 = 0.018 m³）
    const ok = await callRoute(handler, CLIENT, { mark: "XT001", products: [goodRow] });
    assert.ok(!/总重量|体积|方数/.test(ok.message), `正常的一行被派生值闸拦了：${ok.message}`);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/15 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log("算钱数值校验：15 项全部通过");
}

main().catch((e) => { console.error(e); process.exit(1); });
