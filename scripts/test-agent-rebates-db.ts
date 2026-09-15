/**
 * 返现单多进程并发自测（真 PostgreSQL，2026-09-16，Codex 上线前复核 P3-1）。
 *
 * 为什么要这个：scripts/test-agent-rebates.ts 用内存桩；rebate-scheduler.ts 里进程内的 running 标记
 * 只挡得住同一个进程。以后要是同时跑着两个 API 进程，月初两边会同时给同一个代理出同一个月的单，
 * 真正挡住重复的是数据库那几道：agents 行 FOR UPDATE 排队、UNIQUE(agent_id, month)、
 * agent_rebate_lines.prealert_id UNIQUE、P2002 兜底 —— 只有真库、真的多个进程才测得出来。
 *
 * 做法：假公司 zz_rbdb_co 下造一个代理，6 月的单已经出过（还点了已返），7 月有 3 票待出
 * （含北京时间 7-31 23:59:59 签收的边界票），8 月有 1 票还不该出。
 * 起 WORKERS 个独立子进程（各自一个 Prisma 连接池），都连上库后同一刻开跑 generateAgentRebateStatements，断言：
 *   · 几个子进程的执行时间段真的重叠（不重叠等于没测并发，直接判失败）；
 *   · 只出一张 7 月单，3 票各一条明细，合计方数 / 返现对；8 月那票不进单；
 *   · 6 月那张单和明细一个字没动；
 *   · 子进程全部正常退出，都没打「返现单生成失败」这类错误日志（出错会被 generateAgentRebateStatements 吞成日志，只看退出码看不出来）；
 * 再并发重跑一轮：一张都不多出、库里的单和明细完全不变。整套重复 ROUNDS 轮，每轮重新造数据。
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（本机 IPv6 不通、用 IPv4 地址连测试库时，
 * 核实是测试库后设 AGENT_PORTAL_TEST_ALLOW_DB=1，跟 test-agent-portal-isolation 同一个开关）。
 * 没有 DATABASE_URL（CI）打印「跳过」。
 * 用法：npm run test:agent-rebates-db
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

type Row = Record<string, any>;

const CO = "zz_rbdb_co";
const P = "zz_rbdb_";
const AGENT = `${P}ag`;
const CLIENT = `${P}c1`;
const PLAN_NO = "ZZRBDB-PLAN-1";
const WORKERS = 3;
const ROUNDS = 3;
/** 北京时间 8 月 15 日 → 已经过完的最后一个月是 7 月 */
const NOW = "2026-08-15T00:00:00.000Z";
const T = (s: string): Date => new Date(s);

/* ══════════════════════ 子进程 ══════════════════════ */

async function worker(): Promise<void> {
  const { prisma } = await import("../apps/api/src/db/prisma");
  const { logger } = await import("../apps/api/src/modules/core/logger");
  const gen = await import("../apps/api/src/modules/agents/rebate-scheduler");
  const errors: string[] = [];
  const infos: string[] = [];
  const originalError = logger.error;
  const originalInfo = logger.info;
  logger.error = (message: string, data?: unknown) => {
    errors.push(`${message} ${JSON.stringify(data ?? {})}`);
    originalError(message, data);
  };
  logger.info = (message: string, data?: unknown) => {
    infos.push(message);
    originalInfo(message, data);
  };

  // 先把连接建好，免得「谁先连上库谁先跑」把并发变成排队
  await prisma.$queryRaw`SELECT 1`;
  process.stdout.write("READY\n");
  const rl = readline.createInterface({ input: process.stdin });
  const go = await new Promise<string>((resolve) => rl.once("line", resolve));
  rl.close();
  if (go.trim() !== "GO") throw new Error(`子进程收到的不是 GO：${go}`);

  const startedAt = Date.now();
  const result = await gen.generateAgentRebateStatements(new Date(NOW), { agentIds: [AGENT] });
  const endedAt = Date.now();
  process.stdout.write(`RESULT ${JSON.stringify({ result, errors, infos, startedAt, endedAt })}\n`);
  await prisma.$disconnect();
}

/* ══════════════════════ 主进程 ══════════════════════ */

const failures: string[] = [];
let total = 0;
async function check(name: string, body: () => Promise<void>): Promise<void> {
  total += 1;
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").slice(0, 14).join("\n     ")}`);
  }
}

async function cleanup(prisma: any): Promise<void> {
  // 顺序按外键：明细 → 单 → 状态日志 → 货品 → 预报单 → 柜客户 → 柜 → 长期价 → 用户 → 代理
  await prisma.agentRebateLine.deleteMany({ where: { companyId: CO } });
  await prisma.agentRebateStatement.deleteMany({ where: { companyId: CO } });
  await prisma.whrConsolidationStatusLog.deleteMany({ where: { companyId: CO } });
  await prisma.whrConsolidationPrealertItem.deleteMany({ where: { companyId: CO } });
  await prisma.whrConsolidationPrealert.deleteMany({ where: { companyId: CO } });
  await prisma.whrConsolidationPlanCustomer.deleteMany({ where: { companyId: CO } });
  await prisma.whrConsolidationPlan.deleteMany({ where: { companyId: CO } });
  await prisma.clientWhrPrice.deleteMany({ where: { companyId: CO } });
  await prisma.user.deleteMany({ where: { companyId: CO } });
  await prisma.agent.deleteMany({ where: { companyId: CO } });
}

async function leftovers(prisma: any): Promise<number> {
  const counts = await Promise.all([
    prisma.agentRebateLine.count({ where: { companyId: CO } }),
    prisma.agentRebateStatement.count({ where: { companyId: CO } }),
    prisma.whrConsolidationPrealertItem.count({ where: { companyId: CO } }),
    prisma.whrConsolidationPrealert.count({ where: { companyId: CO } }),
    prisma.whrConsolidationPlanCustomer.count({ where: { companyId: CO } }),
    prisma.whrConsolidationPlan.count({ where: { companyId: CO } }),
    prisma.user.count({ where: { companyId: CO } }),
    prisma.agent.count({ where: { companyId: CO } }),
  ]);
  return counts.reduce((s: number, n: number) => s + n, 0);
}

/** 7 月该出的三票：id → [泰国签收时间, 快照返现, 货品 [货型, 方数]] */
const JULY: Array<[string, string, number, Array<[string, number]>]> = [
  [`${P}p1`, "2026-07-05T10:00:00Z", 100, [["normal", 1]]],
  [`${P}p2`, "2026-07-20T10:00:00Z", 150.5, [["normal", 0.5], ["inspection", 1.25]]],
  // 北京时间 7 月 31 日 23:59:59，还算 7 月
  [`${P}p3`, "2026-07-31T15:59:59Z", 200, [["sensitive", 2]]],
];

async function seed(prisma: any): Promise<void> {
  await prisma.agent.create({
    data: { id: AGENT, companyId: CO, name: "并发测试代理ZZRBDB", priceNormal: 500, priceInspection: 550, priceSensitive: 600 },
  });
  await prisma.user.create({
    data: { id: CLIENT, companyId: CO, role: "client", name: "并发测试客户", phone: "0800000000", status: "active", agentId: AGENT },
  });
  await prisma.whrConsolidationPlan.create({
    data: { id: `${P}plan`, companyId: CO, planNo: PLAN_NO, destinationTh: "曼谷", status: "completed", createdBy: `${P}admin`, creatorName: "并发测试" },
  });
  await prisma.whrConsolidationPlanCustomer.create({
    data: { id: `${P}pc`, planId: `${P}plan`, companyId: CO, clientId: CLIENT, unitPriceNormal: 700, unitPriceInspection: 750, unitPriceSensitive: 800 },
  });

  const prealert = async (id: string, receivedAt: string, rebate: number, items: Array<[string, number]>) => {
    await prisma.whrConsolidationPrealert.create({
      data: {
        id, customerId: `${P}pc`, companyId: CO, trackingNo: `ZZRBDB-${id.slice(P.length)}`, mark: "ZZRBDB", status: "thailand_received",
        totalFee: 1000, signedAt: T("2026-06-01T02:00:00Z"), paymentReviewedAt: T("2026-06-02T03:00:00Z"), thailandReceivedAt: T(receivedAt),
        paidPriceNormal: 700, paidPriceInspection: 750, paidPriceSensitive: 800,
        paidAgentId: AGENT, paidAgentPriceNormal: 500, paidAgentPriceInspection: 550, paidAgentPriceSensitive: 600, rebateAmount: rebate,
      },
    });
    await prisma.whrConsolidationPrealertItem.createMany({
      data: items.map(([cargoType, volumeM3], i) => ({
        id: `${P}it_${id.slice(P.length)}_${i}`, prealertId: id, companyId: CO, productName: `并发货${id.slice(P.length)}-${i}`,
        packageCount: 1, material: "布", cargoValue: "100", cargoType, volumeM3, sortOrder: i,
      })),
    });
  };
  await prealert(`${P}p0`, "2026-06-10T04:00:00Z", 60, [["normal", 0.3]]);
  for (const [id, at, rebate, items] of JULY) await prealert(id, at, rebate, items);
  // 北京时间 8 月的，现在（8 月 15 日）还不该出
  await prealert(`${P}p4`, "2026-08-02T00:00:00Z", 50, [["normal", 0.25]]);

  // 6 月的单早就出过、还点了已返：之后谁跑都不许动它
  await prisma.agentRebateStatement.create({
    data: {
      id: `${P}st_jun`, companyId: CO, agentId: AGENT, month: "2026-06", lineCount: 1, totalVolumeM3: 0.3, totalRebate: 60,
      status: "paid", generatedAt: T("2026-07-01T00:30:00Z"), paidAt: T("2026-07-03T00:00:00Z"), paidBy: `${P}admin`,
      lines: {
        create: [{
          id: `${P}ln_p0`, companyId: CO, prealertId: `${P}p0`, trackingNo: "ZZRBDB-p0", planNo: PLAN_NO, clientId: CLIENT, mark: "ZZRBDB",
          productNames: "并发货p0-0", volumeNormalM3: 0.3, volumeInspectionM3: 0, volumeSensitiveM3: 0,
          clientPriceNormal: 700, clientPriceInspection: 750, clientPriceSensitive: 800,
          agentPriceNormal: 500, agentPriceInspection: 550, agentPriceSensitive: 600, rebateAmount: 60,
          prealertCreatedAt: T("2026-06-01T00:00:00Z"), thailandReceivedAt: T("2026-06-10T04:00:00Z"),
        }],
      },
    },
  });
}

/** 这个代理的全部单和明细，序列化成可以直接 deepEqual 的样子 */
async function statementsOf(prisma: any): Promise<Row[]> {
  const rows = await prisma.agentRebateStatement.findMany({
    where: { agentId: AGENT },
    orderBy: { month: "asc" },
    include: { lines: { orderBy: { thailandReceivedAt: "asc" } } },
  });
  return JSON.parse(JSON.stringify(rows));
}

interface WorkerRun {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  done: Promise<{ code: number | null; result: Row | null; output: string }>;
}

const SCRIPT = path.resolve(process.argv[1]);
const TSX = path.resolve(path.dirname(SCRIPT), "../node_modules/.bin/tsx");

function launch(): WorkerRun {
  const child = spawn(TSX, [SCRIPT, "--worker"], { env: { ...process.env, NODE_ENV: "test" }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let result: Row | null = null;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    output += `${line}\n`;
    if (line === "READY") markReady();
    if (line.startsWith("RESULT ")) result = JSON.parse(line.slice("RESULT ".length));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const done = new Promise<{ code: number | null; result: Row | null; output: string }>((resolve) => {
    child.on("close", (code) => resolve({ code, result, output }));
  });
  return { child, ready, done };
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}：${ms / 1000} 秒内没完成`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 起 WORKERS 个子进程，都连上库后同一刻发 GO，等全部退出 */
async function concurrentRun(label: string): Promise<Row[]> {
  const workers = Array.from({ length: WORKERS }, launch);
  try {
    await within(
      Promise.all(
        workers.map((w) =>
          Promise.race([
            w.ready,
            w.done.then((r) => {
              throw new Error(`${label}：子进程还没连上库就退出了（code=${r.code}）\n${r.output}`);
            }),
          ]),
        ),
      ),
      90_000,
      `${label}：子进程连库`,
    );
    for (const w of workers) w.child.stdin.write("GO\n");
    const outs = await within(Promise.all(workers.map((w) => w.done)), 120_000, `${label}：子进程出单`);
    return outs.map((o, i) => {
      assert.equal(o.code, 0, `${label}：第 ${i + 1} 个子进程退出码 ${o.code}\n${o.output}`);
      assert.ok(o.result, `${label}：第 ${i + 1} 个子进程没交回结果\n${o.output}`);
      assert.deepEqual(o.result!.errors, [], `${label}：第 ${i + 1} 个子进程打了错误日志（出单出错被吞了）`);
      return o.result!;
    });
  } finally {
    for (const w of workers) if (w.child.exitCode === null) w.child.kill("SIGKILL");
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url || url.includes("blocked")) {
    console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测");
    return;
  }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  const { prisma } = await import("../apps/api/src/db/prisma");
  console.log(`返现单多进程并发（真库，${WORKERS} 个进程 × ${ROUNDS} 轮）`);

  try {
    await cleanup(prisma);
    for (let round = 1; round <= ROUNDS; round += 1) {
      await check(`第 ${round} 轮：${WORKERS} 个进程同一刻出单 → 只出一张 7 月单、每票一条明细、6 月单不动、没有进程出错；并发重跑一张不多`, async () => {
        await cleanup(prisma);
        await seed(prisma);
        const before = await statementsOf(prisma);
        assert.deepEqual(before.map((s) => s.month), ["2026-06"]);

        const first = await concurrentRun(`第 ${round} 轮`);
        const latestStart = Math.max(...first.map((r) => r.startedAt));
        const earliestEnd = Math.min(...first.map((r) => r.endedAt));
        assert.ok(latestStart < earliestEnd, `几个进程的执行时间没有重叠（最晚开始 ${latestStart}、最早结束 ${earliestEnd}），这一轮等于没测并发`);
        assert.equal(first.reduce((s, r) => s + r.result.statementsCreated, 0), 1, "几个进程合起来只该出 1 张单");
        assert.equal(first.reduce((s, r) => s + r.result.linesCreated, 0), 3, "几个进程合起来只该写 3 条明细");
        for (const r of first) {
          assert.deepEqual(r.result.skippedPrealerts, []);
          assert.deepEqual(r.result.overflowBlocked, []);
        }

        const after = await statementsOf(prisma);
        assert.deepEqual(after.map((s) => s.month), ["2026-06", "2026-07"], "只多出 7 月一张，8 月还没过完不出");
        assert.deepEqual(after[0], before[0], "6 月那张单（含明细、已返状态）一个字都不许动");
        const jul = after[1];
        assert.equal(jul.status, "unpaid");
        assert.equal(jul.generatedAt, NOW);
        assert.equal(jul.lineCount, 3);
        assert.equal(Number(jul.totalVolumeM3), 4.75);
        assert.equal(Number(jul.totalRebate), 450.5);
        assert.deepEqual(jul.lines.map((l: Row) => l.prealertId), JULY.map(([id]) => id));
        assert.deepEqual(jul.lines.map((l: Row) => Number(l.rebateAmount)), [100, 150.5, 200]);
        assert.deepEqual(
          jul.lines.map((l: Row) => [Number(l.volumeNormalM3), Number(l.volumeInspectionM3), Number(l.volumeSensitiveM3)]),
          [[1, 0, 0], [0.5, 1.25, 0], [0, 0, 2]],
        );
        const allLines = await prisma.agentRebateLine.findMany({ where: { companyId: CO }, select: { prealertId: true } });
        assert.deepEqual(
          allLines.map((l: Row) => l.prealertId).sort(),
          [`${P}p0`, `${P}p1`, `${P}p2`, `${P}p3`].sort(),
          "每票恰好一条明细，8 月那票不进",
        );
        const guarded = first.filter((r) => r.infos.includes("返现单：这个月已经出过了（唯一约束兜底）")).length;
        console.log(`     本轮：1 个进程出单，另外 ${WORKERS - 1} 个里 ${guarded} 个靠唯一约束兜底、其余在行锁后重读到已出过`);

        const again = await concurrentRun(`第 ${round} 轮重跑`);
        assert.equal(again.reduce((s, r) => s + r.result.statementsCreated, 0), 0, "重跑一张都不许多出");
        assert.deepEqual(await statementsOf(prisma), after, "重跑后库里的单和明细完全不变");
      });
    }
  } finally {
    await cleanup(prisma).catch((e: unknown) => console.log("  ⚠️ 清理测试数据失败：", e));
    const left = await leftovers(prisma).catch(() => -1);
    console.log(left === 0 ? "  🧹 测试数据已清干净" : `  ⚠️ zz_rbdb_co 还剩 ${left} 行没删掉`);
    if (left !== 0) failures.push("测试数据没清干净");
    await prisma.$disconnect();
  }

  console.log(`\n共 ${total} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) {
    console.log("❌ 失败：\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
  console.log("✅ 全部通过");
}

(process.argv[2] === "--worker" ? worker() : main())
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
