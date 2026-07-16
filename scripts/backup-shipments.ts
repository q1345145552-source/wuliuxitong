#!/usr/bin/env node
/**
 * 运单数据备份脚本 — 每天导出 tracking info
 * 用法: npx tsx scripts/backup-shipments.ts
 * crontab: 每天凌晨 3 点
 */

const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");

const prisma = new PrismaClient();
const BACKUP_DIR = process.env.SHIPMENT_BACKUP_DIR || "/root/shipment-backups";
const FILE = path.join(BACKUP_DIR, `shipments_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`);

async function backup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

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

  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  console.log(`[${new Date().toISOString()}] Backup saved: ${FILE} (${data.length} shipments)`);

  // 保留最近 30 天
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".json")).sort();
  while (files.length > 30) {
    const old = path.join(BACKUP_DIR, files.shift());
    fs.unlinkSync(old);
    console.log(`  删除旧备份: ${old}`);
  }

  await prisma.$disconnect();
}

backup();
