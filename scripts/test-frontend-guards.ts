/**
 * 前端「悄悄替用户填数字」这一类毛病的自测。
 *
 * 老板从第一天起反复报的就是这件事：**「箱数没填，系统自己猜成 1」**。
 * 后端一轮轮收紧，但前端在**发送之前**就把空值换成了数字，
 * 后端那些闸根本挡不到 —— 复核连着好几轮都在这上面找到新的入口。
 *
 * 这个脚本盯三样：
 *   ① 共用的确认收货校验函数本身（纯函数，直接测）
 *   ② 「空着」不许被翻译成 0 发出去（0 和「没填」在这个系统里是两回事：
 *      0 方会让仓库版集货按「方数 × 单价」算出 0 元）
 *   ③ 源码里不许再出现「悄悄兜底成一个数字」的写法
 *      ⚠️ 第 ③ 类只能证明「源码里写了」，证明不了运行时 ——
 *         扫源码的通病，包进 if(false) 就抓不到。别当保险箱。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  optionalNumberForReceive,
  validateReceiveDraft,
} from "../apps/web/src/modules/staff/utils";

const failures: string[] = [];
function check(name: string, body: () => void): void {
  try { body(); console.log(`  ✅ ${name}`); }
  catch (error) {
    failures.push(name);
    const m = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${m.split("\n").join("\n     ")}`);
  }
}

const WEB = path.join(__dirname, "..", "apps", "web", "src");

/** 剔掉注释行再扫 —— 这个项目里「自己的注释骗了自己的扫描器」发生过两次 */
function codeLines(file: string): Array<{ n: number; text: string }> {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    });
}

console.log("前端数字兜底");

check("1) 箱数必须是正整数 —— 0、小数、空都要拦，而且说人话", () => {
  // ⚠️ 边界两头都测：0 拦、1 放行
  assert.ok(validateReceiveDraft({ packageCount: 0 }), "0 箱被放行");
  assert.ok(validateReceiveDraft({ packageCount: "" }), "空箱数被放行");
  assert.ok(validateReceiveDraft({ packageCount: 2.5 }), "2.5 箱被放行");
  assert.ok(validateReceiveDraft({ packageCount: -1 }), "-1 箱被放行");
  assert.equal(validateReceiveDraft({ packageCount: 1 }), null, "1 箱被误拦");
  assert.equal(validateReceiveDraft({ packageCount: 7 }), null, "7 箱被误拦");
  // 提示语要说清楚，不能只写「不合法」
  assert.ok(
    /正整数/.test(validateReceiveDraft({ packageCount: 0 })!),
    "提示语没说清要填什么",
  );
});

check("2) 「空着」不许被翻译成 0 发出去", () => {
  /**
   * ⚠️ 这一条是钱的问题：0 方会让仓库版集货按「方数 × 单价」算出 0 元。
   * 后端的语义是「没传 = 不改」，所以空着就该**根本不发这个字段**。
   */
  for (const empty of ["", "   ", null, undefined, 0, "0", -1, "abc"]) {
    assert.equal(
      optionalNumberForReceive(empty as never),
      undefined,
      `${JSON.stringify(empty)} 应该当成「没填」，结果被当成了一个值`,
    );
  }
  // 真填了的要原样传出去（用互不相同的数，别拿同一个数假绿）
  assert.equal(optionalNumberForReceive(12.5), 12.5);
  assert.equal(optionalNumberForReceive("0.86"), 0.86);
  assert.equal(optionalNumberForReceive(7), 7);
});

check("3) 确认收货那两个弹窗都接了校验，而且失败不许关弹窗", () => {
  /**
   * ⚠️ 员工端那个弹窗以前**一道校验都没有**，而且
   * `setApprovingPrealert(null)` 写在 try/catch **外面** —— 失败也照样关，
   * 员工只看到一闪而过的提示，弹窗没了、填的东西也没了。
   * 管理员端有校验但用的是 `< 1`（2.5 箱能过）。
   */
  const staff = codeLines(path.join(WEB, "app", "staff", "page.tsx"));
  const staffText = staff.map((l) => l.text).join("\n");
  assert.ok(
    /validateReceiveDraft\(draft[,)]/.test(staffText),
    "员工端确认收货弹窗没接校验",
  );
  assert.ok(
    /optionalNumberForReceive\(draft\.weightKg\)/.test(staffText) &&
      /optionalNumberForReceive\(draft\.volumeM3\)/.test(staffText),
    "员工端还在把重量/方数当成 0 发出去",
  );
  /**
   * 关弹窗那句必须在 try 里面（成功之后），不能在 catch 后面。
   * ⚠️ 第一版直接 `indexOf("setApprovingPrealert(null)")`，
   * 结果抓到的是**「取消」按钮**那一处（同文件 ~2414 行）——
   * 干净的代码也被判红。要先把范围缩到「确认收货那个提交函数」里面再找。
   */
  /**
   * ⚠️ 员工端文件里有**两处** `receiveStaffPrealert`（~988 和 ~2426）——
   * 第一版我用 `indexOf` 抓到的是第一处（另一个入口），根本没看弹窗那个。
   * 正是这一项把「还有第三个确认收货入口」逼了出来。
   * 现在两处都要检查。
   */
  const submitStarts: number[] = [];
  for (let i = staffText.indexOf("await receiveStaffPrealert({"); i >= 0;
       i = staffText.indexOf("await receiveStaffPrealert({", i + 1)) {
    submitStarts.push(i);
  }
  /**
   * ⚠️ 数量从 2 降到 1（2026-08-29 第十一轮）：
   * 员工端 ~988 那个 `receivePrealert` 被复核指出是**死代码**（没有任何调用方），
   * 我上轮还给它补了校验 —— 补在永远不执行的代码上，纯属白做。已经删掉。
   * 现在员工端只剩弹窗那一个真入口，加上管理员端一共 2 个。
   */
  assert.equal(submitStarts.length, 1, `员工端确认收货入口数量变了（现在 ${submitStarts.length} 个），请确认每个都接了校验`);
  for (const st of submitStarts) {
    const body = staffText.slice(st, st + 900);
    assert.ok(
      /optionalNumberForReceive\(draft\??\.weightKg\)/.test(body),
      `有一个确认收货入口还在把重量当成 0 发出去：\n${body.slice(0, 200)}`,
    );
  }
  const submitStart = submitStarts[submitStarts.length - 1];
  const submitBody = staffText.slice(submitStart, submitStart + 2500);
  const closeIdx = submitBody.indexOf("setApprovingPrealert(null);");
  const catchIdx = submitBody.indexOf('const text = error instanceof Error ? error.message : "确认收货失败"');
  assert.ok(closeIdx > 0, "提交函数里找不到关弹窗那一句");
  assert.ok(catchIdx > 0, "提交函数里找不到 catch 那一句");
  /* 2026-10-18（全系统审查 F-14 同类）：收货成功后刷新列表失败不能落进「确认收货失败」，关弹窗挪到 try / catch 后面 ——
     那就要求 catch 里失败先 return（失败不许走到关弹窗那句）。两种写法认一种 */
  assert.ok(
    closeIdx < catchIdx || (closeIdx > catchIdx && /return;\s*\}/.test(submitBody.slice(catchIdx, closeIdx))),
    "关弹窗那句排在 catch 后面、catch 里又没先 return —— 说明失败也会关弹窗，员工看不到错在哪",
  );

  const admin = codeLines(path.join(WEB, "app", "admin", "prealerts", "page.tsx"));
  const adminText = admin.map((l) => l.text).join("\n");
  assert.ok(/validateReceiveDraft\(draft[,)]/.test(adminText), "管理员端没走共用校验");
  assert.ok(
    !/draft\.packageCount\s*<\s*1/.test(adminText),
    "管理员端还在用 `< 1` 判箱数 —— 2.5 箱能过",
  );
});

check("4) 柜子总方数不许静默变成 68", () => {
  /**
   * ⚠️ 这个数是「本柜已用方数不许超上限」那道闸的依据，填错了闸就形同虚设。
   * 输入框初值是 68、界面上看得见，问题只出在**手动清空**：
   * `Number(newTotalVolume) || 68` 会悄悄又变回 68。
   */
  const file = path.join(WEB, "app", "admin", "whr-consolidation", "page.tsx");
  const text = codeLines(file).map((l) => l.text).join("\n");
  assert.ok(
    !/Number\(newTotalVolume\)\s*\|\|\s*68/.test(text),
    "总方数还在 `|| 68` 兜底 —— 清空之后会悄悄变回 68",
  );
  assert.ok(
    /请填写柜子总方数/.test(text),
    "清空总方数时没有给出提示，用户不知道自己漏填了",
  );
});

check("5) 那四个数字框：值是 0 要显示成空框，不能显示成 0", () => {
  /**
   * ⚠️ onChange 是 `Number(e.target.value || 0)`，清空就变 0。
   * 把 draft 那四个字段改成 string 要动 40 多处引用 ——
   * 这个项目里我因为「顺手大改」引入新 bug 已经好几次了，不值得。
   * 退一步：让**显示**跟**提交**口径对齐 —— 0 渲染成空框，
   * 提交时 0 当成「没填」。员工看到的是「没填」，不是一个看着像真数据的 0。
   */
  /**
   * ⚠️ **两个页面都有这四个框**（2026-08-29 第十一轮补）。
   * 上一版我只改了员工端那份，复核指出「管理员页面四个输入框清空后仍立即显示 0」。
   * 「两个入口只修一个」—— 这个项目里我已经犯过好几次了。
   */
  const files = [
    path.join(WEB, "components", "staff", "StaffPrealertList.tsx"),
    path.join(WEB, "app", "admin", "prealerts", "page.tsx"),
  ];
  for (const file of files) {
    const text = codeLines(file).map((l) => l.text).join("\n");
    for (const f of ["packageCount", "productQuantity", "weightKg", "volumeM3"]) {
      assert.ok(
        new RegExp(`value=\\{draft\\.${f} \\? String\\(draft\\.${f}\\) : ""\\}`).test(text),
        `${path.basename(file)} 里 ${f} 那个框还在把 0 显示成 "0" —— 员工会以为真的是 0`,
      );
    }
  }
});

check("6) 全仓库不许再出现「悄悄兜底成一个数字」的写法", () => {
  /**
   * ⚠️ 这一项是**兜底**，只能证明「源码里写了」。
   * 包进 if(false) 就抓不到 —— 扫源码的通病，别当保险箱。
   * 真正的守卫是上面 1~5 项。
   */
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      for (const { n, text } of codeLines(full)) {
        // 「数量类字段 + 兜底成非零数字」
        if (
          /(packageCount|weightKg|volumeM3|productQuantity|quantityPerBox|totalVolume)/.test(text) &&
          /(\|\||\?\?)\s*(1|68)\b/.test(text)
        ) {
          hits.push(`${path.relative(WEB, full)}:${n}  ${text.trim().slice(0, 90)}`);
        }
      }
    }
  };
  walk(WEB);
  /**
   * 白名单：**每一条都必须写清为什么安全**，加之前先去读那一行。
   * 这张表越长，这一项越没用。
   */
  const allowed = [
    // 打印标签：显示「第 N 件 / 共 M 件」，不进数据库、不参与任何合计
    "modules/shipment/ShipmentPrintLabel.tsx",
    // 仓库版集货前端估算：只在页面上实时显示预估方数/重量，不发给后端
    "app/client/whr-consolidation/page.tsx",
    /**
     * 装柜进度条那两处 `plan.totalVolumeM3 || 1`（~579、~1154）：
     * 这个 `|| 1` 是**除零保护**，`total` 下一行就拿去当分母算百分比
     *   `Math.round((filled / total) * 100)`
     * 总方数是 0 时分子也没有意义，不兜底会算出 Infinity 显示在界面上。
     * 它不进数据库、不参与任何金额。（2026-08-29 逐行读过确认。）
     */
    "app/staff/whr-consolidation/page.tsx",
    /**
     * 拆柜派送清单导出 `packageTotal ... || 1`：同样是除零保护，
     * 下一行 `Number(product.packageCount || 0) / packageTotal`。
     * 合计为 0 时分子也一定是 0，share 仍是 0；不兜底会把 NaN 印到客户签收单上。
     */
    "modules/lastmile/exportDispatchWorkbooks.ts",
  ];
  const bad = hits.filter((h) => !allowed.some((a) => h.includes(a)));
  assert.deepEqual(bad, [], "下面这些地方还在悄悄替用户填数字：\n     " + bad.join("\n     "));
});


check("7) 前后端口径必须一样 —— 前端放行、后端拒绝比两边都不管更糟", () => {
  /**
   * ⚠️ 复核实测同一份草稿：
   *   前端校验通过 → 发出 `productQuantity: 0` → 后端 400「产品数量必须是正整数」
   * 员工在页面上什么都没做错，点了确认收货却被打回来，还看不懂为什么。
   * 上一版我把 0 判成合法（判的是 `q < 0`），而后端要的是**正整数**。
   */
  // 0 = 「没填」→ 前端放行，但提交时**根本不发这个字段**（下面第 8 项管）
  assert.equal(validateReceiveDraft({ packageCount: 3, productQuantity: 0 }), null);
  // 填了就必须是正整数
  assert.ok(validateReceiveDraft({ packageCount: 3, productQuantity: 2.5 }), "2.5 个被放行");
  assert.ok(validateReceiveDraft({ packageCount: 3, productQuantity: -1 }), "-1 个被放行");
  assert.equal(validateReceiveDraft({ packageCount: 3, productQuantity: 5 }), null, "正常的 5 被误拦");
});

check("8) 「填错了」不许被静默吞掉（跟「空着」是两回事）", () => {
  /**
   * ⚠️ 上一版 `optionalNumberForReceive` 对负数返回 `undefined` = 「当没填」——
   * 于是员工填了 -5kg，页面提示**成功**，数据库里还是旧重量。
   * 他以为改了，其实没改。复核点了这条。
   * 现在：空着 / 0 = 没填（不发）；填了个错的 = 当场拦住说清楚。
   */
  assert.ok(validateReceiveDraft({ packageCount: 3, weightKg: -5 }), "负重量被静默吞掉");
  assert.ok(validateReceiveDraft({ packageCount: 3, volumeM3: -0.5 }), "负体积被静默吞掉");
  assert.ok(validateReceiveDraft({ packageCount: 3, weightKg: "abc" }), "乱填的重量被静默吞掉");
  // 空着和 0 仍然算「没填」，不该报错
  assert.equal(validateReceiveDraft({ packageCount: 3, weightKg: "" }), null);
  assert.equal(validateReceiveDraft({ packageCount: 3, weightKg: 0 }), null);
  assert.equal(validateReceiveDraft({ packageCount: 3, weightKg: 12.5 }), null, "正常重量被误拦");
});

check("9) 两个确认收货入口都不许把产品数量的 0 发出去", () => {
  /**
   * ⚠️ 光在校验函数里把 0 当「没填」不够 —— 提交时还是原样发的话，
   * 后端照样 400。三处都要走 `optionalIntegerForReceive`。
   * （员工端两处 + 管理员端一处。「三个入口只修一个」我犯过好几次。）
   */
  const files = [
    path.join(WEB, "app", "staff", "page.tsx"),
    path.join(WEB, "app", "admin", "prealerts", "page.tsx"),
  ];
  let sites = 0;
  for (const file of files) {
    const text = codeLines(file).map((l) => l.text).join("\n");
    const raw = text.match(/productQuantity:\s*draft\??\.productQuantity\s*,/g) ?? [];
    assert.deepEqual(
      raw,
      [],
      `${path.basename(file)} 里还有地方原样发 productQuantity —— 0 会被后端 400 打回来`,
    );
    sites += (text.match(/optionalIntegerForReceive\(draft\??\.productQuantity\)/g) ?? []).length;
  }
  // 员工端 1（弹窗）+ 管理员端 1 —— 员工端那个死代码入口已删
  assert.equal(sites, 2, `走 optionalIntegerForReceive 的地方是 ${sites} 处，应该是 2 处（员工端 1 + 管理员端 1）`);
});


check("10) 重量体积要按数据库精度判 —— 又是「前端放行、后端拒绝」", () => {
  /**
   * ⚠️ 复核实测：前端放行 `weightKg=0.001` / `volumeM3=0.0001`，
   * 后端按 `Decimal(10,2)` / `Decimal(10,3)` 拒绝 ——
   * 员工点了确认才收到 400，前面白填一遍。
   * **这个病我上一轮才在产品数量上修过，重量体积又犯一次。**
   * ⚠️ 两列精度不一样（重量 2 位、体积 3 位），别拿同一套去卡。
   */
  assert.ok(validateReceiveDraft({ packageCount: 3, weightKg: 0.001 }), "重量 3 位小数被放行");
  assert.ok(validateReceiveDraft({ packageCount: 3, volumeM3: 0.0001 }), "体积 4 位小数被放行");
  // 边界两头都测：合法精度不许被误拦
  assert.equal(validateReceiveDraft({ packageCount: 3, weightKg: 0.01 }), null, "重量 2 位小数被误拦");
  assert.equal(validateReceiveDraft({ packageCount: 3, weightKg: 12.5 }), null, "正常重量被误拦");
  assert.equal(validateReceiveDraft({ packageCount: 3, volumeM3: 0.862 }), null, "体积 3 位小数被误拦");
  assert.equal(validateReceiveDraft({ packageCount: 3, volumeM3: 1.928 }), null, "正常体积被误拦");
});

check("11) 「把原来的数清空」必须当场说清楚，不许静默保留旧值", () => {
  /**
   * ⚠️ 复核实测：员工把原来填着的重量清空 → 页面显示空、提示**保存成功** →
   * 数据库里**还是旧重量**。他以为改了，其实没改，没有任何提示。
   *
   * 病根是我上一轮的取舍「空着 = 不发这个字段」——
   * 对「本来就没填」是对的，对「本来有、现在想清掉」就是错的，
   * 而这两种在草稿里长得一模一样。
   * 后端没有「清零」这个能力，做不到就**明说**，别让员工以为做到了。
   */
  const cleared = validateReceiveDraft({ packageCount: 3, weightKg: 0 }, { weightKg: 88 });
  assert.ok(cleared, "清空了原有重量却没有任何提示 —— 员工会以为改成功了");
  assert.ok(/88/.test(cleared!), `提示里没说清原来是多少：${cleared}`);
  assert.ok(/还是/.test(cleared!), `提示里没说清「保存之后还是旧值」这个后果：${cleared}`);
  // 本来就没填 → 不该报错
  assert.equal(validateReceiveDraft({ packageCount: 3, weightKg: 0 }, { weightKg: 0 }), null, "本来就没填也被拦了");
  assert.equal(validateReceiveDraft({ packageCount: 3, weightKg: 0 }, {}), null, "没有原值也被拦了");
  // 正常改数不许被拦
  assert.equal(validateReceiveDraft({ packageCount: 3, weightKg: 99 }, { weightKg: 88 }), null, "正常改数被拦了");
  // 体积同理
  assert.ok(validateReceiveDraft({ packageCount: 3, volumeM3: 0 }, { volumeM3: 1.928 }), "清空了原有体积没提示");
});

check("12) 两个入口都要把**原值**传给校验，不然那道检查形同虚设", () => {
  /**
   * ⚠️ 光在校验函数里写「清空要报错」没用 —— 调用方不传 original，
   * 那段代码根本不会执行。这正是「加了闸但没接上」那一类。
   */
  for (const file of [
    path.join(WEB, "app", "staff", "page.tsx"),
    path.join(WEB, "app", "admin", "prealerts", "page.tsx"),
  ]) {
    const text = codeLines(file).map((l) => l.text).join("\n");
    assert.ok(
      /validateReceiveDraft\(draft,\s*\{/.test(text),
      `${path.basename(file)} 调 validateReceiveDraft 时没传原值 —— 「清空了旧值」那道检查形同虚设`,
    );
    assert.ok(
      /weightKg:\s*\(item as any\)\.weightKg/.test(text),
      `${path.basename(file)} 传的原值里没有 weightKg`,
    );
  }
});


check("13) 客户看到的轨迹备注里不许出现柜号（两种写法都要抹）", () => {
  /**
   * ⚠️ 老板红线：**客户不能看到柜号**。
   *
   * 脱敏那道闸原来只认「装入柜子 SELU4640250」这一种写法。
   * 上线前排查发现**还有一种**：员工事后补建柜子时写的
   *   「到达凭祥口岸（随柜 L2608219129 补记）」
   * 柜号夹在这句话里，那道闸认不出来，**原样发给了客户**。
   * 生产库只读实测（2026-08-29）：**9 条轨迹、3 张运单**正在漏，
   * 客户在「我的订单」和「查轨迹」两处都看得到。
   * 这是上线前就存在的老洞，不是这次改动弄坏的。
   *
   * ⚠️ 下面这些备注是从**生产库真实数据**里抄出来的，不是我编的。
   */
  const { sanitizeRemarkForClient } = require("../apps/api/src/modules/core/client-privacy") as {
    sanitizeRemarkForClient: (r: string, hide: boolean) => string;
  };
  const 真实备注 = [
    ["到达凭祥口岸（随柜 L2608219129 补记）", "L2608219129"],
    ["已封柜（随柜 L2608198159 补记）", "L2608198159"],
    ["正在卸柜（随柜 L2608219129 补记）", "L2608219129"],
    ["装入柜子 SELU4640250（分装 30件）", "SELU4640250"],
  ];
  for (const [remark, 柜号] of 真实备注) {
    const 客户看到 = sanitizeRemarkForClient(remark, true);
    assert.ok(
      !客户看到.includes(柜号),
      `客户还能看到柜号 ${柜号}：${客户看到}`,
    );
    // 员工那边必须原样看得到 —— 别把内部信息也抹了
    assert.equal(
      sanitizeRemarkForClient(remark, false),
      remark,
      "员工看到的备注被改了 —— 内部要保留柜号",
    );
  }
  // 「随柜补记」这个信息本身要留着：客户需要知道这条是事后补的、不是实时记录
  assert.ok(
    sanitizeRemarkForClient("到达凭祥口岸（随柜 L2608219129 补记）", true).includes("随柜补记"),
    "把「随柜补记」整段删掉了 —— 客户会以为这是实时轨迹",
  );
  // 不带柜号的正常备注不许被动
  assert.equal(
    sanitizeRemarkForClient("国内仓已收货，等待装柜", true),
    "国内仓已收货，等待装柜",
    "正常备注被误改了",
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/13 项不通过：${failures.join("；")}`);
  process.exit(1);
}
console.log("前端数字兜底：13 项全部通过");
