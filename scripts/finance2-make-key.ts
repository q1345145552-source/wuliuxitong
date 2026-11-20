/**
 * 生成一把「财务系统2 拉物流系统」用的专用密钥（2026-11-19）。
 * 用法：npx tsx scripts/finance2-make-key.ts
 *
 * 打印两样：
 *   密钥 —— 交给财务系统2，放它服务器的环境变量里（它每次请求带 Authorization: Bearer <密钥>）
 *   指纹 —— 填进物流系统服务器 .env 的 FINANCE2_API_KEY_SHA256（换密钥时旧指纹挪到 FINANCE2_API_KEY_SHA256_PREV）
 * 物流系统这边只存指纹、不存密钥。密钥别发群里、别进 git、别贴进文档。
 */
import { randomBytes } from "node:crypto";
import { sha256HexOf } from "../apps/api/src/modules/finance2/api-key";

const key = randomBytes(32).toString("base64url");
console.log(`密钥（给财务系统2）：${key}`);
console.log(`指纹（物流系统 .env 的 FINANCE2_API_KEY_SHA256）：${sha256HexOf(key)}`);
