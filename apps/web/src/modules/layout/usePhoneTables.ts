"use client";

import { useEffect } from "react";

/**
 * 手机上把普通表格摊成「一行一块」（2026-10-05 老板拍板「1a」：列表一单一块）。
 *
 * 系统里几十张表（集货任务、财务、充值审核、客户 / 员工账号……）在手机上都要左右拖。一张张改写太多、也容易漏，
 * 这里统一处理：只在手机宽度下，给页面里的表格每一格标上它那一列的表头（data-label），再加一个 phone-stack 标记；
 * 样式（globals.css「手机排版」那段）把每一行排成一块：第一格当标题，其余每格「左边列名、右边内容」。
 * 电脑上这个钩子什么都不做，表格一个字不动。
 *
 * 不碰的表：带 data-phone="keep" 的（自己有手机写法，或者本来就该横着看的小表），
 * 以及放在 .is-phone-hidden 里的（那张宽表手机上已经换成别的列表了；但它详情弹窗里的表照常摊）。
 */

const HANDLED = "phoneStack";

/** 导出给测试用（scripts/test-phone-layout.ts 拿假的表格跑） */
export function labelTable(table: HTMLTableElement): void {
  if (table.dataset.phone === "keep") return;
  // 收起来的电脑宽表（以及它普通行里的小表）不碰；但宽表「详情」那一行里挂的弹窗是看得见的，里面的表（货物明细）照常摊
  if (table.closest(".is-phone-hidden") && !table.closest(".shipment-detail-row")) return;
  const headRow = table.tHead?.rows[table.tHead.rows.length - 1];
  if (!headRow) return; // 没有表头的不摊：不知道每格叫什么
  const labels: string[] = [];
  for (const th of Array.from(headRow.cells)) {
    const text = (th.textContent ?? "").replace(/\s+/g, " ").trim();
    for (let i = 0; i < Math.max(1, th.colSpan); i++) labels.push(text);
  }
  for (const body of Array.from(table.tBodies)) {
    // 上面行用 rowSpan 占住的列（集货签收那种「唛头 / 运单号跨好几行」的表）：这些列号下面几行要跳过，
    // 不然第 2 行起列名整体错位（dsh 10-05 复审抓到）。occupied[列号] = 还要被占几行
    let occupied: number[] = [];
    for (const row of Array.from(body.rows)) {
      const nextOccupied = occupied.map((n) => (n > 0 ? n - 1 : 0));
      let col = 0;
      let titled = false;
      for (const cell of Array.from(row.cells)) {
        while ((occupied[col] ?? 0) > 0) col++;
        const span = Math.max(1, cell.colSpan);
        const rowSpan = Math.max(1, cell.rowSpan || 1);
        if (rowSpan > 1) for (let k = 0; k < span; k++) nextOccupied[col + k] = rowSpan - 1;
        if (span > 1 && span >= labels.length - 1) {
          // 跨满整行的格子（展开的明细、空表提示）：整块显示，不配列名
          cell.dataset.label = "";
          cell.classList.add("phone-cell-full");
        } else {
          cell.dataset.label = labels[col] ?? "";
          const text = (cell.textContent ?? "").trim();
          const onlyCheckbox = !!cell.querySelector("input[type=checkbox]") && !text;
          // 空着的格（没内容或只有「—」）手机上不占一行，每块紧凑些；里面有按钮 / 输入框的不算空
          const empty = !onlyCheckbox && /^[—–-]?$/.test(text) && !cell.querySelector("button, input, select, textarea, a, img");
          cell.classList.toggle("phone-cell-empty", empty);
          cell.classList.toggle("phone-cell-check", onlyCheckbox);
          // 标题 = 第一格真有内容的（只有「—」的不算，不然标题跟着空格一起被藏掉）
          const isTitle = !titled && !onlyCheckbox && !empty && text !== "";
          cell.classList.toggle("phone-cell-title", isTitle);
          if (isTitle) titled = true;
        }
        col += span;
      }
      occupied = nextOccupied;
    }
  }
  if (table.dataset[HANDLED] !== "1") {
    table.dataset[HANDLED] = "1";
    table.classList.add("phone-stack");
  }
}

/**
 * 外壳在手机宽度下调用：盯着页面，工作台内容里的表格出现 / 换了数据就重新标一遍。
 * 盯的是整个 body（外壳刚挂上时内容区可能还没渲染出来），只处理 .dashboard-content 里面的表。
 */
export function usePhoneTables(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const root = document.body;
    let scheduled = false;
    const run = () => {
      scheduled = false;
      for (const table of Array.from(root.querySelectorAll<HTMLTableElement>(".dashboard-content table"))) labelTable(table);
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(run);
    };
    run();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      // 从手机宽度变回电脑宽度（旋转平板 / 拉宽窗口）：标记撤掉，电脑上的表格一点不受影响
      for (const table of Array.from(root.querySelectorAll("table.phone-stack"))) {
        table.classList.remove("phone-stack");
        delete (table as HTMLTableElement).dataset[HANDLED];
      }
    };
  }, [enabled]);
}
