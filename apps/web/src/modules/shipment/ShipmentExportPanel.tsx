"use client";

import { useId, useRef, type ReactNode } from "react";

export default function ShipmentExportPanel({ children, onOpen }: { children: ReactNode; onOpen?: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  return (
    <>
      <button type="button" className="workbench-button" aria-haspopup="dialog" onClick={() => { onOpen?.(); dialogRef.current?.showModal(); }}>导出 Excel</button>
      <dialog ref={dialogRef} className="shipment-export-dialog" aria-labelledby={titleId} onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']"));
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}>
        <div className="shipment-export-dialog-heading">
          <h2 id={titleId}>导出运单</h2>
          <button type="button" className="workbench-button" onClick={() => dialogRef.current?.close()} aria-label="关闭导出设置">关闭</button>
        </div>
        <p className="shipment-export-dialog-intro">按下面的条件导出；条件是打开时从列表带过来的，可以改、可以清空。留空就是不限制。</p>
        {children}
      </dialog>
    </>
  );
}
