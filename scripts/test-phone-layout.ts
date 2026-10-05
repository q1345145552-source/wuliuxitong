/**
 * 手机排版（2026-10-05 老板拍板「1a2a」：列表一单一块 + 手机底部加常用入口）—— 不开浏览器的测试。
 *
 * 盯：
 *   M1 底部入口照老板认的那几个配（客户 运单/集货/客服/我的；员工 运单/预报单/装柜/派送/消息；管理员 首页/运单/集货/账号/更多），
 *      每个入口指向的菜单项都真的存在（菜单改了名 / 删了，这里会红）
 *   M2 手机才有的样式全在「≤640px」那段里 —— 电脑上一条都不生效（「只改外观不改排版」红线）
 *   M3 普通表格摊平：每格按表头（含跨列）标列名；第一格当标题、只有勾选框的不当标题；空格标出来隐藏；
 *      跨满整行的格整块显示；带 data-phone="keep" 的、放在 .is-phone-hidden 里的不碰
 *   M4 三端运单页：一单一块的列表只在手机上渲染，电脑那张宽表手机上收起（详情 / 编辑弹窗那一行留着）；
 *      查询框运单号那一格常驻（8-11 老板删过客户端「折叠」：查询框不能藏）
 *   M5 客服两页在手机上扣掉底部那排的高度（不然输入框被盖住）
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps/web/src");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

// ---------- 一个够用的假 DOM（只实现 labelTable 用到的那几样） ----------
class FakeClassList {
  set = new Set<string>();
  add(c: string) { this.set.add(c); }
  remove(c: string) { this.set.delete(c); }
  toggle(c: string, on?: boolean) { const want = on ?? !this.set.has(c); if (want) this.set.add(c); else this.set.delete(c); return want; }
  contains(c: string) { return this.set.has(c); }
}
class FakeCell {
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  rowSpan = 1;
  constructor(public textContent: string, public colSpan = 1, public inner: string[] = []) {}
  querySelector(sel: string) {
    const wanted = sel.split(",").map((s) => s.trim().replace(/\[.*\]/, ""));
    const checkbox = sel.includes("input[type=checkbox]");
    if (checkbox) return this.inner.includes("checkbox") ? {} : null;
    return this.inner.some((tag) => wanted.includes(tag) || (tag === "checkbox" && wanted.includes("input"))) ? {} : null;
  }
}
class FakeRow { constructor(public cells: FakeCell[]) {} }
class FakeTable {
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  tHead: { rows: FakeRow[] } | null;
  tBodies: Array<{ rows: FakeRow[] }>;
  /** 祖先身上有哪些类（只认 labelTable 会问的那两个：.is-phone-hidden / .shipment-detail-row） */
  ancestors: Set<string>;
  constructor(head: FakeCell[] | null, body: FakeCell[][], hiddenParent: boolean | string[] = false) {
    this.tHead = head ? { rows: [new FakeRow(head)] } : null;
    this.tBodies = [{ rows: body.map((cells) => new FakeRow(cells)) }];
    this.ancestors = new Set(hiddenParent === true ? [".is-phone-hidden"] : hiddenParent === false ? [] : hiddenParent);
  }
  closest(sel: string) { return this.ancestors.has(sel) ? {} : null; }
}
const th = (t: string, span = 1) => new FakeCell(t, span);
const td = (t: string, inner: string[] = [], span = 1) => new FakeCell(t, span, inner);
const tdRows = (t: string, rowSpan: number) => Object.assign(new FakeCell(t), { rowSpan });

async function main(): Promise<void> {
  // ---------- M1 ----------
  const menu = await import("../apps/web/src/modules/layout/menu-config");
  await check("M1 底部入口照老板认的配（10-05「2a」）", () => {
    const labels = (role: keyof typeof menu.phoneTabs) => menu.phoneTabs[role].map((t) => t.label);
    assert.deepEqual(labels("client"), ["运单", "集货", "客服", "我的"]);
    assert.deepEqual(labels("staff"), ["运单", "预报单", "装柜", "派送", "消息"]);
    assert.deepEqual(labels("admin"), ["首页", "运单", "集货", "账号", "更多"]);
    for (const role of ["client", "staff", "admin", "agent"] as const) {
      assert.ok(menu.phoneTabs[role].length <= 5, `${role} 底部超过 5 个，手机上挤`);
    }
  });
  await check("M1 每个底部入口指向的菜单项都真的存在、属于这个角色；「我的 / 更多」是打开完整菜单", () => {
    for (const role of ["client", "staff", "admin", "agent"] as const) {
      const ids = new Set(menu.roleFunctionGroups[role].flatMap((g) => g.items.map((i) => i.id)));
      for (const tab of menu.phoneTabs[role]) {
        if (tab.more) { assert.ok(!tab.menuIds?.length, `${role}「${tab.label}」既是更多又指了页面`); continue; }
        assert.ok(tab.menuIds && tab.menuIds.length > 0, `${role}「${tab.label}」没指页面`);
        for (const id of tab.menuIds) assert.ok(ids.has(id), `${role}「${tab.label}」指的 ${id} 不在菜单里`);
      }
    }
    // 两个版本的集货都给（近两周两边用的人一样多）
    assert.deepEqual(menu.phoneTabs.client[1].menuIds, ["client-func-consolidation", "client-func-whr-consolidation"]);
  });
  await check("M1 地址没写 # 时的默认栏目跟各页自己的默认一致（底部「当前在哪」靠它）", () => {
    assert.equal(menu.DEFAULT_SECTION_HASH["/staff"], "#staff-prealert-review");
    assert.match(read("app/staff/page.tsx"), /: "staff-prealert-review";/);
    assert.equal(menu.DEFAULT_SECTION_HASH["/admin"], "#overview");
    assert.match(read("app/admin/page.tsx"), /: "overview";/);
    assert.equal(menu.DEFAULT_SECTION_HASH["/client"], "#client-main");
    assert.match(read("app/client/page.tsx"), /setActiveSection\("client-main"\)/);
  });

  // ---------- M2 ----------
  await check("M2 手机才有的样式全在「≤640px」那段里，电脑上一条都不生效", () => {
    const css = fs.readFileSync(path.join(WEB, "app/globals.css"), "utf8");
    const start = css.indexOf("手机排版（2026-10-05");
    assert.ok(start > 0, "找不到手机排版那段");
    const tail = css.slice(start);
    const media = tail.indexOf("@media (max-width: 640px) {");
    assert.ok(media > 0);
    // 从 @media 开始数括号，找到这一段结束的位置；之后不许再出现手机专用的类名
    let depth = 0, end = -1;
    for (let i = media; i < tail.length; i++) {
      if (tail[i] === "{") depth++;
      else if (tail[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, "手机排版那段括号没配平");
    const before = css.slice(0, start);
    const after = tail.slice(end + 1);
    const phoneOnly = /\.(phone-|ship-phone|cl-grid|cl-list|cl-detail|cl-bill|staff-prealert-head|client-prealert-pager|client-price-row|is-phone-hidden|cs-client-page|has-phone-tabs)/;
    for (const [where, text] of [["手机排版那段前面", before], ["手机排版那段后面", after]] as const) {
      const hit = text.split("\n").find((line) => phoneOnly.test(line) && !line.trim().startsWith("/*") && !line.trim().startsWith("*"));
      assert.equal(hit, undefined, `${where}有手机专用样式写在 @media 外面（电脑上也会生效）：${hit}`);
    }
  });

  // ---------- M3 ----------
  const { labelTable } = await import("../apps/web/src/modules/layout/usePhoneTables");
  await check("M3 每格按表头标列名（跨列的表头算几列）；第一格有字的当标题、只有勾选框的不当标题", () => {
    const t = new FakeTable(
      [th(""), th("任务编号"), th("客户"), th("金额", 2), th("操作")],
      [[td("", ["checkbox"]), td("JH0001"), td("测试唛头"), td("¥51.00"), td("未付"), td("删除", ["button"])]],
    );
    labelTable(t as unknown as HTMLTableElement);
    const cells = t.tBodies[0].rows[0].cells;
    assert.deepEqual(cells.map((c) => c.dataset.label), ["", "任务编号", "客户", "金额", "金额", "操作"]);
    assert.ok(cells[0].classList.contains("phone-cell-check"));
    assert.ok(!cells[0].classList.contains("phone-cell-title"));
    assert.ok(cells[1].classList.contains("phone-cell-title"), "标题应是第一格有字的「任务编号」");
    assert.ok(t.classList.contains("phone-stack"));
  });
  await check("M3 空格（没字或只有「—」）标出来藏掉；有按钮 / 输入框的不算空", () => {
    const t = new FakeTable(
      [th("单号"), th("备注"), th("重量"), th("操作")],
      [[td("SEED1"), td("—"), td(""), td("", ["button"])]],
    );
    labelTable(t as unknown as HTMLTableElement);
    const [no, remark, weight, act] = t.tBodies[0].rows[0].cells;
    assert.ok(!no.classList.contains("phone-cell-empty"));
    assert.ok(remark.classList.contains("phone-cell-empty"));
    assert.ok(weight.classList.contains("phone-cell-empty"));
    assert.ok(!act.classList.contains("phone-cell-empty"), "放按钮的格不能藏");
  });
  await check("M3 跨满整行的格（展开的明细、空表提示）整块显示，不配列名", () => {
    const t = new FakeTable([th("A"), th("B"), th("C")], [[td("暂无数据", [], 3)]]);
    labelTable(t as unknown as HTMLTableElement);
    const c = t.tBodies[0].rows[0].cells[0];
    assert.equal(c.dataset.label, "");
    assert.ok(c.classList.contains("phone-cell-full"));
  });
  await check("M3 上面行跨行占住的列（集货签收：唛头 / 运单号跨好几行），下面几行列名不错位（dsh 10-05）", () => {
    const t = new FakeTable(
      [th("唛头"), th("运单号"), th("产品名称"), th("件数"), th("体积")],
      [
        [tdRows("XHH-1", 3), tdRows("YW001", 3), td("产品一"), td("5"), td("0.1")],
        [td("产品二"), td("8"), td("0.2")],
        [td("产品三"), td("2"), td("0.3")],
        [td("XHH-2"), td("YW002"), td("产品四"), td("1"), td("0.4")], // 跨行结束后下一票从第 0 列重新数
      ],
    );
    labelTable(t as unknown as HTMLTableElement);
    const rows = t.tBodies[0].rows.map((r) => r.cells.map((c) => c.dataset.label));
    assert.deepEqual(rows[0], ["唛头", "运单号", "产品名称", "件数", "体积"]);
    assert.deepEqual(rows[1], ["产品名称", "件数", "体积"]);
    assert.deepEqual(rows[2], ["产品名称", "件数", "体积"]);
    assert.deepEqual(rows[3], ["唛头", "运单号", "产品名称", "件数", "体积"]);
    assert.ok(t.tBodies[0].rows[1].cells[0].classList.contains("phone-cell-title"), "第 2 件货以产品名当标题");
  });
  await check("M3 不碰的表：data-phone=keep、放在 .is-phone-hidden 里的、没表头的", () => {
    const keep = new FakeTable([th("A")], [[td("1")]]);
    keep.dataset.phone = "keep";
    const hidden = new FakeTable([th("A")], [[td("1")]], true);
    const noHead = new FakeTable(null, [[td("1")]]);
    for (const t of [keep, hidden, noHead]) {
      labelTable(t as unknown as HTMLTableElement);
      assert.ok(!t.classList.contains("phone-stack"));
      assert.equal(t.tBodies[0].rows[0].cells[0].dataset.label, undefined);
    }
  });
  await check("M3 收起的宽表「详情」那一行弹窗里的表（货物明细）照常摊；宽表普通行里的小表不碰（Codex 10-05）", () => {
    const inDetail = new FakeTable([th("#"), th("品名")], [[td("1"), td("玩具")]], [".is-phone-hidden", ".shipment-detail-row"]);
    labelTable(inDetail as unknown as HTMLTableElement);
    assert.ok(inDetail.classList.contains("phone-stack"), "详情弹窗里的货物明细没摊开");
    const inRow = new FakeTable([th("#"), th("品名")], [[td("1"), td("玩具")]], [".is-phone-hidden"]);
    labelTable(inRow as unknown as HTMLTableElement);
    assert.ok(!inRow.classList.contains("phone-stack"));
  });
  await check("M3 数据变了再标一次：标题跟着换、上一轮的空标记撤掉", () => {
    const cells = [td("—"), td("JH2")];
    const t = new FakeTable([th("备注"), th("单号")], [cells]);
    labelTable(t as unknown as HTMLTableElement);
    assert.ok(!cells[0].classList.contains("phone-cell-title"), "只有「—」的格当了标题，又被当空格藏掉，这一块就没标题了");
    assert.ok(cells[1].classList.contains("phone-cell-title"));
    cells[0].textContent = "急件";
    labelTable(t as unknown as HTMLTableElement);
    assert.ok(cells[0].classList.contains("phone-cell-title"));
    assert.ok(!cells[1].classList.contains("phone-cell-title"));
    assert.ok(!cells[0].classList.contains("phone-cell-empty"));
  });

  // ---------- M4 ----------
  await check("M4 三端运单页：一单一块只在手机上渲染，宽表手机上收起，详情 / 编辑那一行留着", () => {
    for (const [file, table] of [
      ["app/staff/page.tsx", "table-card staff-shipment-table-scroll"],
      ["app/client/page.tsx", "shipment-table-scroll"],
      ["app/admin/page.tsx", "table-card shipment-table-scroll"],
    ] as const) {
      const src = read(file);
      assert.match(src, /\{isPhone \? \(?(\(\) => \{[\s\S]{0,400})?\s*<ShipmentPhoneList/, `${file}：手机列表不是只在手机上渲染`);
      assert.ok(src.includes(`isPhone ? "${table} is-phone-hidden" : "${table}"`), `${file}：宽表在手机上没收起`);
      assert.ok((src.match(/className="shipment-detail-row"/g) ?? []).length >= 1, `${file}：详情那一行没标出来（手机上会被一起藏掉）`);
    }
    assert.equal((read("app/admin/page.tsx").match(/className="shipment-detail-row"/g) ?? []).length, 2, "管理员的详情、编辑两行都要留");
  });
  await check("M4 查询框运单号那一格常驻（8-11 定的查询框不藏），其余条件才收起", () => {
    const bar = read("modules/shipment/PhoneSearchBar.tsx");
    assert.match(bar, /placeholder="搜运单号"/);
    assert.match(read("app/staff/page.tsx"), /<PhoneSearchBar/);
    assert.match(read("app/admin/page.tsx"), /<PhoneSearchBar/);
    const client = read("app/client/page.tsx");
    assert.match(client, /isPhone && !phoneMoreFilters \? "client-order-search phone-collapsed"/);
    const css = fs.readFileSync(path.join(WEB, "app/globals.css"), "utf8");
    assert.match(css, /\.client-order-search\.phone-collapsed \.client-search-field:not\(:first-of-type\) \{ display: none; \}/, "客户端收起时第一格（运单号）也被藏了");
    assert.match(client, /<label className="client-search-field"><span>运单号<\/span>/, "客户端查询区第一格不是运单号了，上面那条规则会藏错");
  });

  await check("M4 电脑那一行能做的事手机上一样不少：员工 勾选 + 打印；管理员 勾选 + 编辑 / 打印 / 删除（dsh 10-05）", () => {
    const phoneBlock = (src: string) => {
      const at = src.indexOf("<ShipmentPhoneList");
      assert.ok(at > 0);
      return src.slice(at, src.indexOf("/>", src.indexOf("selection={{", at)) + 2);
    };
    const staff = phoneBlock(read("app/staff/page.tsx"));
    for (const label of ["物流轨迹", "打印"]) assert.ok(staff.includes(`label: "${label}"`), `员工手机列表少了「${label}」`);
    assert.match(staff, /toggleSelectShipment\(item\.trackingNo\)/, "员工手机列表不能勾选");
    assert.match(staff, /onToggle: toggleSelectAll/, "员工手机列表没有「选择全部筛选结果」");
    const admin = phoneBlock(read("app/admin/page.tsx"));
    for (const label of ["物流轨迹", "编辑", "打印", "删除"]) assert.ok(admin.includes(`label: "${label}"`), `管理员手机列表少了「${label}」`);
    assert.match(admin, /onToggle: toggleSelectOrder/, "管理员手机列表不能勾选");
    assert.match(admin, /onToggle: toggleSelectAllOrders/);
    // 电脑上点单号能复制，三端手机上也要有
    assert.ok(staff.includes('label: "复制单号"') && staff.includes("copyShipmentNumber("), "员工手机列表少了「复制单号」");
    assert.ok(admin.includes('label: "复制单号"') && admin.includes("copyOrderNumber("), "管理员手机列表少了「复制单号」");
    const client = read("app/client/page.tsx");
    const clientBlock = client.slice(client.indexOf("<ShipmentPhoneList"), client.indexOf("/>", client.indexOf("<ShipmentPhoneList")) + 2);
    assert.ok(clientBlock.includes('label: "复制单号"') && clientBlock.includes("copyOrderNumber("), "客户手机列表少了「复制单号」");
    // 电脑和手机走同一个打印 / 删除，不是抄两份
    assert.equal((read("app/admin/page.tsx").match(/deleteAdminOrder\(/g) ?? []).length, 1, "删除运单的逻辑应该只有一份");
    assert.equal((read("app/staff/page.tsx").match(/openPrintLabel\(/g) ?? []).length, 1, "员工打印逻辑应该只有一份");
  });

  // ---------- M5 ----------
  await check("M5 客服两页手机上扣掉底部那排的高度", () => {
    const css = fs.readFileSync(path.join(WEB, "app/globals.css"), "utf8");
    assert.match(css, /\.has-phone-tabs :is\(\.cs-client-page, \.cs-inbox\) \{\s*height: calc\(100dvh - 72px - 60px - env\(safe-area-inset-bottom\)\) !important;/);
    assert.match(read("app/client/chat/page.tsx"), /className="cs-client-page"/);
    assert.match(read("app/staff/chat/page.tsx"), /"cs-inbox cs-inbox--open" : "cs-inbox"/);
  });
  await check("M5 底部留白压得过 ledger.css（它后加载、两个类；我们要三个类，不然拉到底的按钮被底部那排盖住，dsh 10-05）", () => {
    const css = fs.readFileSync(path.join(WEB, "app/globals.css"), "utf8");
    assert.match(css, /\.dashboard-layout\.has-phone-tabs \.dashboard-content \{ padding-bottom: calc\(60px/);
    const ledger = fs.readFileSync(path.join(WEB, "app/ledger.css"), "utf8");
    for (const m of ledger.matchAll(/^\s*([^{}\n]*\.dashboard-content)\s*\{[^}]*padding/gm)) {
      const classes = (m[1].match(/\.[\w-]+/g) ?? []).length;
      assert.ok(classes < 3, `ledger.css 的「${m[1].trim()}」有 ${classes} 个类，会盖掉手机底部留白`);
    }
    const layout = read("app/layout.tsx");
    assert.ok(layout.indexOf('"./globals.css"') < layout.indexOf('"./ledger.css"'), "加载顺序变了，上面那条推理要重看");
  });
  await check("M2 收起宽表只藏它自己的表头 / 行（一律「>」），不许写成后代选择器把详情弹窗里的表一起藏掉（Codex 10-05）", () => {
    const css = fs.readFileSync(path.join(WEB, "app/globals.css"), "utf8");
    const phone = css.slice(css.indexOf("手机排版（2026-10-05"));
    const bad = phone.split("\n").find((line) => /\.is-phone-hidden\s+(thead|tbody|tr|colgroup|td|th|table)\b/.test(line));
    assert.equal(bad, undefined, `有后代选择器会伤到详情弹窗里的表：${bad}`);
    assert.match(phone, /\.is-phone-hidden > table > tbody > tr:not\(\.shipment-detail-row\) \{ display: none; \}/);
  });
  await check("M5 底部弹出那一小块：按返回键 / 地址变了也收起（外壳换页不卸载，dsh 10-05）", () => {
    const bar = read("modules/layout/PhoneTabBar.tsx");
    assert.match(bar, /addEventListener\("popstate", close\)/);
    assert.match(bar, /addEventListener\("hashchange", close\)/);
  });
  await check("M2 手机样式不用 :has()（老安卓 WebView 不认，整条会被丢掉）", () => {
    const css = fs.readFileSync(path.join(WEB, "app/globals.css"), "utf8");
    const phone = css.slice(css.indexOf("手机排版（2026-10-05"));
    const hit = phone.split("\n").find((line) => line.includes(":has(") && !line.trim().startsWith("/*"));
    assert.equal(hit, undefined, `手机样式里还有 :has()：${hit}`);
  });

  console.log(`\n手机排版 ${passed} 项全部通过`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
