/**
 * 生成一把「财务系统2 拉物流系统」用的专用密钥（2026-11-19）。
 * 用法：npx tsx scripts/finance2-make-key.ts            取运单那把（只读接口，填 FINANCE2_API_KEY_SHA256）
 *       npx tsx scripts/finance2-make-key.ts balance    客户余额那把（会动钱，填 FINANCE2_BALANCE_KEY_SHA256；2026-11-27）
 *       两把必须各生成各的，不能用同一把（物流这边配成同一把会当没配齐，余额接口回 503）。
 *
 * 打印两样：
 *   密钥 —— 交给财务系统2，放它服务器的环境变量里（它每次请求带 Authorization: Bearer <密钥>）
 *   指纹 —— 填进物流系统服务器 .env 的 FINANCE2_API_KEY_SHA256（换密钥时旧指纹挪到 FINANCE2_API_KEY_SHA256_PREV）
 * 物流系统这边只存指纹、不存密钥。密钥别发群里、别进 git、别贴进文档。
 */
import { randomBytes } from "node:crypto";
import { sha256HexOf } from "../apps/api/src/modules/finance2/api-key";

const which = process.argv[2] ?? "";
if (which !== "" && which !== "balance") {
  console.error("参数只能不写（取运单那把）或写 balance（客户余额那把）");
  process.exit(1);
}
const balance = which === "balance";
const key = randomBytes(32).toString("base64url");
const envName = balance ? "FINANCE2_BALANCE_KEY_SHA256" : "FINANCE2_API_KEY_SHA256";
const theirName = balance ? "LOGISTICS_BALANCE_API_KEY" : "物流取运单的密钥";
console.log(`这一把是：${balance ? "客户余额接口（/integrations/finance2-balance/v1，会动钱）" : "只读接口（/integrations/finance2/v1，取运单）"}`);
console.log(`密钥（给财务系统2，它那边放 ${theirName}）：${key}`);
console.log(`指纹（物流系统 .env 的 ${envName}；换钥匙时旧指纹挪到 ${envName}_PREV）：${sha256HexOf(key)}`);
