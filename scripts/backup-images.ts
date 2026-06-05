#!/usr/bin/env node
/**
 * 产品图片自动备份脚本
 * 用法: npx tsx scripts/backup-images.ts
 * 建议: crontab 每天执行一次
 *   0 3 * * * cd /root/MyWebSite && npx tsx scripts/backup-images.ts >> /var/log/image-backup.log 2>&1
 */

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

const BACKUP_DIR = process.env.IMAGE_BACKUP_DIR || "/root/image-backups";
const DAYS_OLD = 3;

async function backup() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS_OLD);

  const images = await prisma.orderProductImage.findMany({
    where: {
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: "asc" },
  });

  if (images.length === 0) {
    console.log(`[${new Date().toISOString()}] 没有超过 ${DAYS_OLD} 天的图片需要备份`);
    await prisma.$disconnect();
    return;
  }

  // 按日期分目录
  const dateDirs = new Set<string>();
  for (const img of images) {
    const dateDir = img.createdAt.toISOString().slice(0, 10);
    dateDirs.add(dateDir);
  }

  for (const d of dateDirs) {
    fs.mkdirSync(path.join(BACKUP_DIR, d), { recursive: true });
  }

  let saved = 0;
  let skipped = 0;

  for (const img of images) {
    const dateDir = img.createdAt.toISOString().slice(0, 10);
    const ext = img.mime?.split("/")[1] || "jpg";
    const safeName = img.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = path.join(BACKUP_DIR, dateDir, `${img.createdAt.toISOString().slice(11, 19).replace(/:/g, "-")}_${img.id}_${safeName}.${ext}`);

    if (fs.existsSync(filePath)) {
      skipped++;
      continue;
    }

    try {
      const buffer = Buffer.from(img.contentBase64, "base64");
      fs.writeFileSync(filePath, buffer);
      saved++;
    } catch (e) {
      console.error(`写入失败: ${filePath}`, e);
    }
  }

  console.log(`[${new Date().toISOString()}] 备份完成: 保存 ${saved} 张, 跳过 ${skipped} 张 (已存在), 目录: ${BACKUP_DIR}`);
  await prisma.$disconnect();
}

backup();
