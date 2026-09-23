"use client";

/**
 * 员工端「整柜管理」（2026-09-23）。
 * ⚠️ 界面全在共用组件 FclContainerWorkbench 里 —— 超管端那一页用的是同一个组件，
 * 别在这儿另写一套（尾端派送当年两套各写各的，改一边忘一边，CLAUDE.md 第 20 条）。
 */
import FclContainerWorkbench from "../../../components/fcl/FclContainerWorkbench";

export default function StaffFclContainersPage() {
  return (
    <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
      <FclContainerWorkbench />
    </div>
  );
}
