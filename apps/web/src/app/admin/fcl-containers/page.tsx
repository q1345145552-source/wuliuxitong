"use client";

/**
 * 超管端「整柜管理」（2026-09-23）。
 * canUnsign：撤销误签收只给超管，跟普通尾端派送同一个规矩（员工点错了找管理员撤）。
 * ⚠️ 跟员工端共用同一个组件 FclContainerWorkbench，别在这儿另写一套。
 * 差别只有一处：超管在轨迹里能看到操作人（后端按角色决定给不给，见 hideOperatorIdentity）。
 */
import FclContainerWorkbench from "../../../components/fcl/FclContainerWorkbench";

export default function AdminFclContainersPage() {
  return (
    <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
      <FclContainerWorkbench canUnsign canDelete />
    </div>
  );
}
