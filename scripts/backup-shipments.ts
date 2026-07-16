#!/usr/bin/env node
/**
 * 加固版：数据库备份 — 导出全部运单数据为JSON
 * crontab: 0 3 * * * cd /root/MyWebSite && npx tsx scripts/backup-shipments.ts >> /var/log/shipment-backup.log 2>&1
 */

const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");

const prisma = new PrismaClient();
const BACKUP_DIR = process.env.SHIPMENT_BACKUP_DIR || "/root/shipment-backups";
const RETENTION_DAYS = 30;
const MIN_SIZE_KB = 1;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function backup() {
  log("========== 运单备份开始 ==========");

  try {
    // 1. 确保目录存在 + 磁盘检查
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const avail = require("child_process")
      .execSync(`df -m "${BACKUP_DIR}" | tail -1 | awk '{print $4}'`)
      .toString().trim();
    if (parseInt(avail) < 100) {
      log(`⛔ 磁盘空间不足：${avail}MB`);
      process.exit(1);
    }

    // 2. 导出数据
    const shipments = await prisma.shipment.findMany({
      select: {
        trackingNo: true,
        parentTrackingNo: true,
        currentStatus: true,
        itemName: true,
        packageCount: true,
        weightKg: true,
        volumeM3: true,
        transportMode: true,
        batchNo: true,
        containerNo: true,
        remark: true,
        createdAt: true,
        updatedAt: true,
        order: { select: { clientId: true, itemName: true } },
      },
      orderBy: { updatedAt: "desc" },
    });

    const data = shipments.map(s => ({
      trackingNo: s.trackingNo,
      parentTrackingNo: s.parentTrackingNo,
      clientId: s.order?.clientId,
      itemName: s.itemName || s.order?.itemName,
      status: s.currentStatus,
      pkg: s.packageCount,
      weight: s.weightKg,
      volume: s.volumeM3,
      mode: s.transportMode,
      batchNo: s.batchNo,
      containerNo: s.containerNo,
      remark: s.remark,
      created: s.createdAt,
      updated: s.updatedAt,
    }));

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const tmpFile = path.join(BACKUP_DIR, `shipments_${today}.tmp.json`);
    const finalFile = path.join(BACKUP_DIR, `shipments_${today}.json`);

    // 3. 写入临时文件
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));

    // 4. 验证：能parse才算成功
    const check = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
    const size = fs.statSync(tmpFile).size;
    const sizeKb = Math.round(size / 1024);

    if (!Array.isArray(check) || check.length === 0 || sizeKb < MIN_SIZE_KB) {
      log(`⛔ 备份验证失败：${check.length} 条，${sizeKb}KB`);
      fs.unlinkSync(tmpFile);
      process.exit(1);
    }

    // 5. 原子替换
    fs.renameSync(tmpFile, finalFile);
    log(`✅ 备份成功：${finalFile} (${check.length} 条，${sizeKb}KB)`);

    // 6. 清理旧备份
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.match(/^shipments_\d{8}\.json$/))
      .sort();
    while (files.length > RETENTION_DAYS) {
      const old = path.join(BACKUP_DIR, files.shift());
      fs.unlinkSync(old);
      log(`  删除旧备份：${old}`);
    }

    log(`当前备份数：${files.length}`);
  } catch (e) {
    log(`⛔ 备份异常：${e.message}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }

  log("========== 运单备份完成 ==========");
}

backup();
