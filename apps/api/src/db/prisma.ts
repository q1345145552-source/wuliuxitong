/**
 * Prisma Client 单例
 *
 * 用法：
 *   import { prisma } from "../db/prisma";
 *   const user = await prisma.user.findUnique({ where: { id } });
 *
 * 注意：
 *   1. 全局只有一个 Prisma Client 实例，避免开发模式下 hot-reload 创建过多连接
 *   2. 启动时会校验 DATABASE_URL 是否配置
 */
import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL?.trim()) {
  // eslint-disable-next-line no-console
  console.warn(
    "[prisma] DATABASE_URL 未配置，Prisma 将无法连接数据库。请在 .env 中设置 DATABASE_URL。",
  );
}

// 在开发模式下复用同一个实例（避免 tsx watch 时反复创建连接池）
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

const prisma =
  globalThis.__prisma ??
  new PrismaClient({
    log:
      process.env.PRISMA_LOG === "1"
        ? ["query", "info", "warn", "error"]
        : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}

export { prisma };
export type { PrismaClient };
