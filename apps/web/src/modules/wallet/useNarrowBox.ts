"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 这一块（不是整个窗口）有多宽：窄于 limit 就换成「一条一块」的排法（2026-11-27 客户余额页）。
 * 按容器量而不是按窗口量：平板上左边还有侧边栏，窗口 768 宽、内容只剩 500 来宽，表格照样要横着滚。
 * 第一次量出来之前当「不窄」（电脑上排版不动）。
 */
export function useNarrowBox<T extends HTMLElement>(limit: number): { ref: React.RefObject<T | null>; narrow: boolean } {
  const ref = useRef<T | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => setNarrow(el.clientWidth > 0 && el.clientWidth < limit);
    sync();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", sync);
      return () => window.removeEventListener("resize", sync);
    }
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [limit]);
  return { ref, narrow };
}
