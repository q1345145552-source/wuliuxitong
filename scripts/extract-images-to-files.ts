/**
 * 将数据库中的 base64 图片提取为磁盘文件，并更新 file_path。
 * 运行：npx tsx scripts/extract-images-to-files.ts
 */
import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const IMAGES_DIR = process.env.IMAGES_DIR || "/images";

const prisma = new PrismaClient();

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
    "image/webp": ".webp", "image/bmp": ".bmp",
  };
  return map[mime] ?? ".jpg";
}

async function main() {
  ensureDir(IMAGES_DIR);

  // 只处理 file_path 为空的记录
  const images = await prisma.orderProductImage.findMany({
    where: { filePath: null },
    select: { id: true, orderId: true, mime: true, contentBase64: true },
    take: 5000,
  });

  console.log(`Found ${images.length} images to extract...`);

  let count = 0;
  for (const img of images) {
    try {
      const ext = mimeToExt(img.mime);
      const name = `${img.orderId}_${crypto.randomBytes(6).toString("hex")}${ext}`;
      const filePath = path.join(IMAGES_DIR, name);
      const buffer = Buffer.from(img.contentBase64, "base64");
      fs.writeFileSync(filePath, buffer);

      await prisma.orderProductImage.update({
        where: { id: img.id },
        data: { filePath: `/images/${name}` },
      });

      count++;
      if (count % 100 === 0) console.log(`  ${count}/${images.length} done`);
    } catch (e) {
      console.error(`  Failed for ${img.id}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`Done. Extracted ${count} images.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
