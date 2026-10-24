/**
 * ⚠️ 禁库硬闸：这个脚本只测订单照片上传的纯规则，不许连数据库。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";

/**
 * 订单照片上传的规则（2026-10-24 老板「不要给客户任何编辑的权限」；规则在 apps/api/src/modules/orders/product-images.ts）：
 *   R1 客户什么时候还能传：自己报的预报单（shipped）、建好 1 小时内（含边界）
 *   R2 哪些数据库错误算「同事在处理」
 *   R3 记库失败以后文件留不留、回什么话 —— 按「出错时事务里那段跑完、要去提交了没有」分（没跑完：肯定没存上；跑完了：卡在提交那一下，拿不准）
 *   R4 同上，拿不准时回查的三种结果
 *   R5 客户的话不说「再传一次」
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
  saveFailedMessage,
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
      unknown("ERROR: deadlock detected"), unknown("ERROR: could not serialize access due to concurrent update"),
      unknown('QueryError(PostgresError { code: "40P01", message: "...", severity: "ERROR" })'), unknown("Raw query failed. Code: `40001`. Message: `...`")]) {
      assert.equal(isOrderBusyError(e), true, `${(e as any).code ?? e.message} 应算同事在处理`);
    }
    // 原文里碰巧有 40001 这串数字（比如唯一键的值）不算（dsh 第 4 轮）
    for (const e of [known("P2002"), known("P2003"), known("P2010", undefined, "Key (order_no)=(40001) already exists"),
      unknown("value 40001 out of range"), new Error("deadlock detected"), new BusinessError("x", 400, "BAD_REQUEST"), null, undefined]) {
      assert.equal(isOrderBusyError(e), false, `${(e as any)?.code ?? (e as any)?.message ?? e} 不该算同事在处理`);
    }
  });

  await check("R3 事务里那段没跑完就出错：提交根本没发出去，肯定没存上 —— 删文件、不回查；同事在处理 409、业务原因照原因回、其余 500", async () => {
    let lookups = 0;
    const found = async () => { lookups += 1; return true; };
    let a = await failedUploadAction(new BusinessError("预报单提交以后，照片就不能再加了；要补照片请联系客服", 403, "FORBIDDEN"), "client", false, found);
    assert.deepEqual(a, { keepFile: false, respond: { kind: "fail", status: 403, code: "FORBIDDEN", message: "预报单提交以后，照片就不能再加了；要补照片请联系客服" } });
    // 等连接 / 等锁 / 开不了事务超时、死锁：409（Codex / dsh 第 4 轮：原来先回查，连接池满时回查也失败、409 到不了）
    for (const e of [known("P2024"), known("P2028"), known("P2034"), unknown("ERROR: deadlock detected")]) {
      a = await failedUploadAction(e, "staff", false, found);
      assert.equal(a.keepFile, false, `${(e as any).code ?? e.message} 留了文件`);
      assert.equal(a.respond.kind === "fail" && a.respond.status, 409, `${(e as any).code ?? e.message} 没回 409`);
    }
    // 连接断了、认不出的错：没插进去也是肯定没存上
    for (const e of [known("P2002"), known("P1017"), unknown("Server has closed the connection"), new Error("socket hang up")]) {
      a = await failedUploadAction(e, "staff", false, found);
      assert.equal(a.keepFile, false, `${(e as any).code ?? e.message} 留了文件`);
      assert.equal(a.respond.kind === "fail" && a.respond.status, 500);
    }
    assert.equal(lookups, 0, "没跑完就出错的还去回查了");
  });

  await check("R4 跑完了再出错（卡在提交那一下，含 P2028 提交超时）：回查 —— 查得到按成功、查不到或查不了都留文件回「确认不了」；业务错误也不例外", async () => {
    let lookups = 0;
    const found = async () => { lookups += 1; return true; };
    const absent = async () => { lookups += 1; return false; };
    const broken = async (): Promise<boolean> => { lookups += 1; throw new Error("连接池满了"); };
    // Codex / dsh 第 5 轮：Prisma 5.22 把提交也算在事务期限里，提交时超时报 P2028，库里可能已经存上了 —— 不能删文件
    // 业务错误也放进来：以后有人在跑完以后抛业务错误，也不能把可能已存上的文件删掉（dsh 第 6 轮）
    for (const e of [known("P2028"), known("P1017"), unknown("Server has closed the connection"), known("P2034"), new BusinessError("x", 400, "BAD_REQUEST")]) {
      let a = await failedUploadAction(e, "staff", true, found);
      assert.deepEqual(a, { keepFile: true, respond: { kind: "ok" } }, `${(e as any).code ?? e.message}：其实存上了，应按成功回、留文件`);
      a = await failedUploadAction(e, "staff", true, absent);
      assert.equal(a.keepFile, true, `${(e as any).code ?? e.message}：查不到也删了文件（提交可能还没看得见，删了就是裂图）`);
      assert.match(a.respond.kind === "fail" ? a.respond.message : "", /确认不了/);
      a = await failedUploadAction(e, "staff", true, broken);
      assert.equal(a.keepFile, true, `${(e as any).code ?? e.message}：查不了也删了文件`);
      assert.match(a.respond.kind === "fail" ? a.respond.message : "", /确认不了/);
    }
    assert.equal(lookups, 15);
  });

  await check("R5 客户看到的话不说「再传一次」（客户页面没有重传入口，页面会自己接一句「联系客服补上」）；员工的照旧说", async () => {
    // 第二项是「事务里那段跑完、要去提交了没有」（reachedCommit）
    const cases: Array<[unknown, boolean, () => Promise<boolean>]> = [
      [known("P2024"), false, async () => false], [known("P2002"), false, async () => false],
      [known("P2028"), true, async () => false], [known("P1017"), true, async () => { throw new Error("x"); }],
    ];
    for (const [e, reachedCommit, lookup] of cases) {
      const c = await failedUploadAction(e, "client", reachedCommit, lookup);
      const st = await failedUploadAction(e, "staff", reachedCommit, lookup);
      assert.ok(c.respond.kind === "fail" && !/再传/.test(c.respond.message), `客户看到：${c.respond.kind === "fail" ? c.respond.message : "ok"}`);
      assert.ok(st.respond.kind === "fail" && /再传/.test(st.respond.message), `员工看到：${st.respond.kind === "fail" ? st.respond.message : "ok"}`);
      assert.equal(c.keepFile, st.keepFile, "客户和员工留不留文件不该不一样");
    }
    // 写磁盘失败那条也一样（Codex 第 5 轮）
    assert.ok(!/再传/.test(saveFailedMessage("client")));
    assert.ok(/再传/.test(saveFailedMessage("staff")) && /再传/.test(saveFailedMessage("admin")));
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/5 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log("\n订单照片上传规则：5 项全部通过");
}

main().catch((e) => { console.error(e); process.exit(1); });
