"use client";

import { useEffect, useState } from "react";

type ToastProps = {
  open: boolean;
  message: string;
  tone?: "success" | "error";
  /** 自动关闭时间(ms)，默认2200，传0不自动关闭 */
  duration?: number;
};

export default function Toast({ open, message, tone = "success", duration = 2200 }: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!open || !message) { setVisible(false); return; }
    setVisible(true);
    if (duration <= 0) return;
    const timer = setTimeout(() => setVisible(false), duration);
    return () => clearTimeout(timer);
  }, [open, message, duration]);

  if (!visible) return null;
  return <div className={`biz-toast ${tone === "error" ? "biz-toast-error" : "biz-toast-success"}`}>{message}</div>;
}
