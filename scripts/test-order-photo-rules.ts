/**
 * ⚠️ 禁库硬闸：这个脚本只测订单照片上传的纯规则，不许连数据库。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";

/**
 * 订单照片上传的规则（2026-10-24 老板「不要给客户任何编辑的权限」；规则在 apps/api/src/modules/orders/product-images.ts）：
 *   R1 客户什么时候还能传：自己报的预报单（shipped）、建好 1 小时内（含边界）
 *   R2 哪些数据库错误算「同事在处理」
 *   R3 哪些失败能肯定「没存上」
 *   R4 记库失败以后文件留不留、回什么话（每种情况）；客户的话不说「再传一次」
 * 整条接口（锁、并发、真文件）在 test-client-photo-lock-db.ts 里测。
 */
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { BusinessError } from "../apps/api/src/modules/core/business-error";
import {
  CLIENT_PREALERT_PHOTO_WINDOW_MS,
  clientMayAddOrderPhoto,
  failedUploadAction,
  isOrderBusyError,
  surelyNotSaved,
} from "../apps/api/src/modules/orders/product-images";

const failures: string[] = [];
async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

const known = (code: string, meta?: Record<string, unknown>, message = "x") => new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "test", meta });
const unknown = (message: string) => new Prisma.PrismaClientUnknownRequestError(message, { clientVersion: "test" });

async function main(): Promise<void> {
  console.log("订单照片上传规则");

  await check("R1 客户只能往自己报、没收货、建好 1 小时内（含正好 1 小时）的单传", () => {
    const now = Date.now();
    const at = (msAgo: number, approvalStatus = "shipped") => ({ approvalStatus, createdAt: new Date(now - msAgo) });
    assert.equal(CLIENT_PREALERT_PHOTO_WINDOW_MS, 60 * 60 * 1000);
    assert.equal(clientMayAddOrderPhoto(at(0), now), true);
    assert.equal(clientMayAddOrderPhoto(at(CLIENT_PREALERT_PHOTO_WINDOW_MS), now), true, "正好 1 小时还算");
    assert.equal(clientMayAddOrderPhoto(at(CLIENT_PREALERT_PHOTO_WINDOW_MS + 1), now), false, "过了 1 小时还能传");
    for (const status of ["received", "approved", "pending", ""]) {
      assert.equal(clientMayAddOrderPhoto(at(0, status), now), false, `${status || "空"} 状态的单客户也能传`);
    }
  });

  await check("R2 等锁 / 等连接超时、死锁、串行化失败算「同事在处理」；唯一冲突、外键、普通报错不算", () => {
    for (const e of [known("P2028"), known("P2024"), known("P2034"), known("P2010", { code: "40P01" }), known("P2010", { code: "40001" }),
      unknown("ERROR: deadlock detected"), unknown("ERROR: could not serialize access due to concurrent update")]) {
      assert.equal(isOrderBusyError(e), true, `${(e as any).code ?? e.message} 应算同事在处理`);
    }
    // 原文里碰巧有 40001 这串数字（比如唯一键的值）不算（dsh 第 4 轮）
    for (const e of [known("P2002"), known("P2003"), known("P2010", undefined, "Key (order_no)=(40001) already exists"),
      unknown("value 40001 out of range"), new Error("deadlock detected"), new BusinessError("x", 400, "BAD_REQUEST"), null, undefined]) {
      assert.equal(isOrderBusyError(e), false, `${(e as any)?.code ?? (e as any)?.message ?? e} 不该算同事在处理`);
    }
  });

  await check("R3 能肯定没存上：业务原因、执行某一句就报错的；拿不准：连接类（P1xxx）、认不出的错", () => {
    for (const e of [new BusinessError("x", 403, "FORBIDDEN"), known("P2002"), known("P2003"), known("P2024"), known("P2028"), unknown("ERROR: deadlock detected")]) {
      assert.equal(surelyNotSaved(e), true, `${(e as any).code ?? (e as any).message} 应能肯定没存上`);
    }
    for (const e of [known("P1001"), known("P1017"), unknown("Server has closed the connection"), new Error("socket hang up"), null]) {
      assert.equal(surelyNotSaved(e), false, `${(e as any)?.code ?? (e as any)?.message ?? e} 不该肯定没存上`);
    }
  });

  await check("R4 记库失败以后：肯定没存上就删文件；拿不准就回查——查得到按成功、查不到或查不了都留文件回「确认不了」", async () => {
    let lookups = 0;
    const found = async () => { lookups += 1; return true; };
    const absent = async () => { lookups += 1; return false; };
    const broken = async (): Promise<boolean> => { lookups += 1; throw new Error("连接池满了"); };

    // 业务原因：删文件、照原因回、不用回查
    let a = await failedUploadAction(new BusinessError("预报单提交以后，照片就不能再加了；要补照片请联系客服", 403, "FORBIDDEN"), "client", found);
    assert.deepEqual(a, { keepFile: false, respond: { kind: "fail", status: 403, code: "FORBIDDEN", message: "预报单提交以后，照片就不能再加了；要补照片请联系客服" } });
    // 等连接超时 / 等锁超时 / 死锁：删文件、409、不用回查（Codex / dsh 第 4 轮：原来先回查，连接池满时回查也失败，409 永远到不了）
    for (const e of [known("P2024"), known("P2028"), known("P2034")]) {
      a = await failedUploadAction(e, "staff", broken);
      assert.equal(a.keepFile, false, `${(e as any).code} 留了文件`);
      assert.equal(a.respond.kind === "fail" && a.respond.status, 409, `${(e as any).code} 没回 409`);
    }
    // 唯一冲突之类：删文件、500
    a = await failedUploadAction(known("P2002"), "staff", found);
    assert.equal(a.keepFile, false);
    assert.equal(a.respond.kind === "fail" && a.respond.status, 500);
    assert.equal(lookups, 0, "肯定没存上的还去回查了");

    // 拿不准（连接断了）：回查
    a = await failedUploadAction(known("P1017"), "staff", found);
    assert.deepEqual(a, { keepFile: true, respond: { kind: "ok" } }, "提交其实成功了，应按成功回、留文件");
    a = await failedUploadAction(known("P1017"), "staff", absent);
    assert.equal(a.keepFile, true, "拿不准、查不到也删了文件（提交可能还没看得见，删了就是裂图）");
    assert.match(a.respond.kind === "fail" ? a.respond.message : "", /确认不了/);
    a = await failedUploadAction(unknown("Server has closed the connection"), "staff", broken);
    assert.equal(a.keepFile, true, "连查都查不了还删了文件");
    assert.match(a.respond.kind === "fail" ? a.respond.message : "", /确认不了/);
    assert.equal(lookups, 3);
  });

  await check("R5 客户看到的话不说「再传一次」（客户页面没有重传入口，页面会自己接一句「联系客服补上」）；员工的照旧说", async () => {
    const cases: Array<[unknown, () => Promise<boolean>]> = [
      [known("P2024"), async () => false], [known("P2002"), async () => false], [known("P1017"), async () => false],
      [known("P1017"), async () => { throw new Error("x"); }],
    ];
    for (const [e, lookup] of cases) {
      const c = await failedUploadAction(e, "client", lookup);
      const s = await failedUploadAction(e, "staff", lookup);
      assert.ok(c.respond.kind === "fail" && !/再传/.test(c.respond.message), `客户看到：${c.respond.kind === "fail" ? c.respond.message : "ok"}`);
      assert.ok(s.respond.kind === "fail" && /再传/.test(s.respond.message), `员工看到：${s.respond.kind === "fail" ? s.respond.message : "ok"}`);
      assert.equal(c.keepFile, s.keepFile, "客户和员工留不留文件不该不一样");
    }
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/5 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log("\n订单照片上传规则：5 项全部通过");
}

main().catch((e) => { console.error(e); process.exit(1); });
