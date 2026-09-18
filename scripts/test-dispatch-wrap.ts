/** 真导出函数 + 原始 XLSX 模板 + SheetJS 回读；不连网、不连库。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import JSZip from "../apps/web/node_modules/jszip";
import * as XLSX from "../apps/web/node_modules/xlsx";
import { buildLastmileTemplateWorkbook, type LastmileExportData } from "../apps/web/src/modules/lastmile/exportDispatchWorkbooks";

const root = process.cwd();
const failures: string[] = [];
let checks = 0;
const longName = "服装配件家居用品厨房收纳儿童玩具电脑附件".repeat(6).slice(0, 112) + "品名终点";
const names = ["第一种", "第二种", "第三种", "第四种", "第五种", "第六种", "第七种", "第八种", "第九种", "末尾品"];
function data(scope: "container" | "customer", itemName: string, count = 1): LastmileExportData {
  return {
    containerId: "test-container", containerNo: "TEST", containerType: "40HQ", origin: "测试仓", destination: "测试目的仓", carrierInfo: "测试承运人", deliveryNo: "WDTEST", scope,
    carrierName: "测试承运人", driverName: "测试司机", licensePlate: "TEST", phoneNumber: "0800000000", deliveryDate: "2026-09-12", status: "DELIVERING", customerCount: 1,
    shipmentCount: count, signedCount: 0, totalPackageCount: count * 2, totalVolumeM3: count * 0.048, totalWeightKg: count * 19.76, containerNos: ["TEST"], generatedAt: "2026-09-12T00:00:00Z",
    customers: [{ clientId: "TESTCLIENT", contactName: "测试收件人", contactPhone: "0800000000", address: "测试地址", addressLabel: "测试地址",
      shipments: Array.from({ length: count }, (_, i) => ({ lastmileOrderId: `test-lm-${i}`, trackingNo: `TEST${i}`, parentTrackingNo: "", itemName,
        packageCount: 2, packageUnit: "箱", volumeM3: 0.048, weightKg: 19.76, lengthCm: "60/50", widthCm: 40, heightCm: 30, remark: "原样备注", status: "DELIVERING", containerNos: ["TEST"],
        receiverName: "测试收件人", receiverPhone: "0800000000", receiverAddress: "测试地址", products: [] })) }],
  };
}
async function template(scope: "container" | "customer") {
  return fs.readFileSync(path.join(root, "apps/web/public/templates/lastmile", scope === "container" ? "internal-dispatch-template.xlsx" : "customer-receipt-template.xlsx"));
}
async function build(scope: "container" | "customer", itemName: string, count = 1, bytes?: Uint8Array) {
  const input = data(scope, itemName, count);
  const snapshot = JSON.stringify(input);
  const output = await buildLastmileTemplateWorkbook(input, bytes ?? await template(scope));
  assert.equal(JSON.stringify(input), snapshot, "导出不得改写输入");
  const book = XLSX.read(output, { type: "array", cellStyles: true });
  return { output, book, zip: await JSZip.loadAsync(output) };
}
const rowHeight = (sheet: XLSX.WorkSheet, row: number) => Number(sheet["!rows"]?.[row - 1]?.hpt);
async function check(name: string, run: () => Promise<void>) {
  checks += 1;
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
async function main() {
  await check("1 actual 13pt container font: 116 CJK name has adequate height", async () => {
    const { book } = await build("container", longName); const s = book.Sheets[book.SheetNames[0]];
    assert.equal(s.C10.v, longName); assert.ok(rowHeight(s, 10) >= 160, `13pt 长品名行高 ${rowHeight(s, 10)}pt 仍不足`);
  });
  for (const [label, separator] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]]) {
    await check(`2 ${label}: ten explicit lines preserved and fit in all three sheets`, async () => {
      for (const scope of ["customer", "container"] as const) {
        const input = names.join(separator); const { book } = await build(scope, input);
        const reference = await build(scope, names.join("\n"));
        for (let i = 0; i < book.SheetNames.length; i++) {
          const s = book.Sheets[book.SheetNames[i]], row = scope === "container" ? 10 : i === 0 ? 6 : 8, col = scope === "container" ? "C" : "D";
          assert.equal(s[`${col}${row}`].v, input, `${scope}/${i} 换行字面内容变了`);
          assert.ok(rowHeight(s, row) >= (scope === "container" ? 160 : 130), `${scope}/${i} 十行高度只有 ${rowHeight(s, row)}pt`);
          assert.equal(rowHeight(s, row), rowHeight(reference.book.Sheets[reference.book.SheetNames[i]], row), "CRLF 应只算一次换行");
        }
      }
    });
  }
  await check("3 explicit breaks plus wrapping accumulate; blank lines are kept", async () => {
    const input = `${"品".repeat(40)}\n\n${names.join("\n")}`;
    const { book } = await build("customer", input); const s = book.Sheets[book.SheetNames[0]];
    assert.equal(s.D6.v, input); assert.ok(rowHeight(s, 6) >= 210, `显式空行/自动折行漏计 ${rowHeight(s, 6)}`);
  });
  await check("4 short names preserve original row heights, styles and print geometry", async () => {
    for (const scope of ["customer", "container"] as const) {
      const source = await template(scope), original = XLSX.read(source, { type: "buffer", cellStyles: true }), originalZip = await JSZip.loadAsync(source);
      const { book, zip } = await build(scope, "鞋 / 包 / 帽");
      assert.equal(await zip.file("xl/styles.xml")!.async("string"), await originalZip.file("xl/styles.xml")!.async("string"));
      for (let i = 0; i < book.SheetNames.length; i++) {
        assert.deepEqual(book.Sheets[book.SheetNames[i]]["!rows"], original.Sheets[original.SheetNames[i]]["!rows"]);
        const a = await zip.file(`xl/worksheets/sheet${i + 1}.xml`)!.async("string"), b = await originalZip.file(`xl/worksheets/sheet${i + 1}.xml`)!.async("string");
        for (const tag of ["cols", "mergeCells", "pageMargins", "pageSetup", "printOptions", "rowBreaks", "colBreaks"]) {
          const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/(?:\\w+:)?${tag}>)`);
          assert.equal(re.exec(a)?.[0], re.exec(b)?.[0], `${scope}/${tag} 发生额外改动`);
        }
      }
    }
  });
  await check("5 template font/column changes drive height, including cloned pages", async () => {
    const zipped = await JSZip.loadAsync(await template("container"));
    const styles = await zipped.file("xl/styles.xml")!.async("string");
    zipped.file("xl/styles.xml", styles.replace(/<sz val="13"\s*\/>/g, '<sz val="18"/>'));
    const bytes = await zipped.generateAsync({ type: "uint8array" });
    const base = await build("container", longName), larger = await build("container", longName, 26, bytes);
    const baseHeight = rowHeight(base.book.Sheets[base.book.SheetNames[0]], 10);
    const largeHeight = rowHeight(larger.book.Sheets[larger.book.SheetNames[0]], 10);
    assert.ok(largeHeight > baseHeight, `模板改成18pt后行高没变 ${baseHeight}/${largeHeight}`);
    assert.equal(rowHeight(larger.book.Sheets[larger.book.SheetNames[1]], 10), largeHeight, "续页未使用实际字体");
    const xml = await zipped.file("xl/worksheets/sheet1.xml")!.async("string");
    zipped.file("xl/worksheets/sheet1.xml", xml.replace(/(<col\b[^>]*min="3"[^>]*width=")[^"]+/, '$112'));
    const narrow = await build("container", longName, 1, await zipped.generateAsync({ type: "uint8array" }));
    assert.ok(rowHeight(narrow.book.Sheets[narrow.book.SheetNames[0]], 10) > largeHeight, "实际列宽没参与估高");
  });
  await check("6 26 shipments keep every name, dimensions, quantities and page totals", async () => {
    for (const scope of ["customer", "container"] as const) {
      const { book } = await build(scope, longName, 26);
      assert.equal(book.SheetNames.length, scope === "container" ? 2 : 6);
      const qtyCol = scope === "container" ? "D" : "E", volumeCol = scope === "container" ? "E" : "F", weightCol = scope === "container" ? "F" : "G";
      for (let i = 0; i < book.SheetNames.length; i++) {
        const page = scope === "container" ? i : Math.floor(i / 2), cap = scope === "container" ? 25 : 10;
        const row = scope === "container" ? 10 : i % 2 === 0 ? 6 : 8, col = scope === "container" ? "C" : "D", total = scope === "container" ? 35 : i % 2 === 0 ? 16 : 28;
        const s = book.Sheets[book.SheetNames[i]], count = Math.min(cap, 26 - page * cap);
        for (let j = 0; j < count; j++) {
          assert.equal(s[`${col}${row + j}`].v, longName); assert.equal(s[`${qtyCol}${row + j}`].v, 2);
          assert.equal(s[`${volumeCol}${row + j}`].v, 0.048); assert.equal(s[`${weightCol}${row + j}`].v, 19.76);
          if (scope === "container") assert.equal(s[`G${row + j}`].v, "60/50");
        }
        assert.equal(s[`${volumeCol}${total}`].v, Math.round(count * 0.048 * 1e6) / 1e6);
        assert.equal(s[`${weightCol}${total}`].v, Math.round(count * 19.76 * 100) / 100);
      }
    }
  });
  await check("7 extreme names retain literal content and bounded height", async () => {
    for (const scope of ["customer", "container"] as const) {
      const input = "品".repeat(1000), { book } = await build(scope, input);
      const s = book.Sheets[book.SheetNames[0]], row = scope === "container" ? 10 : 6, col = scope === "container" ? "C" : "D";
      assert.equal(s[`${col}${row}`].v, input); assert.ok(rowHeight(s, row) <= 400, `20行保护失效 ${rowHeight(s, row)}`);
    }
  });
  await check("8 wide Latin letters fit; narrow letters and combining marks are not double width", async () => {
    for (const scope of ["customer", "container"] as const) {
      const text = "W".repeat(120) + "ENDW";
      const wide = await build(scope, text), narrow = await build(scope, "i".repeat(120));
      for (let i = 0; i < wide.book.SheetNames.length; i++) {
        const row = scope === "container" ? 10 : i === 0 ? 6 : 8, col = scope === "container" ? "C" : "D";
        const sheet = wide.book.Sheets[wide.book.SheetNames[i]];
        assert.equal(sheet[`${col}${row}`].v, text);
        assert.ok(rowHeight(sheet, row) >= 190, `${scope}/${i} 宽拉丁字母只有 ${rowHeight(sheet, row)}pt`);
        assert.ok(rowHeight(sheet, row) > rowHeight(narrow.book.Sheets[narrow.book.SheetNames[i]], row), "宽窄字形预算相同");
      }
      const consonants = await build(scope, "ก".repeat(40)), marked = await build(scope, "ก่".repeat(40));
      for (let i = 0; i < consonants.book.SheetNames.length; i++) {
        const row = scope === "container" ? 10 : i === 0 ? 6 : 8;
        assert.equal(rowHeight(consonants.book.Sheets[consonants.book.SheetNames[i]], row), rowHeight(marked.book.Sheets[marked.book.SheetNames[i]], row), "泰文声调组合符不另占一个字宽");
      }
    }
  });
  console.log(`dispatch-wrap: ${checks - failures.length}/${checks} passed; FAILURES ${failures.length}`);
  if (failures.length) process.exitCode = 1;

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
