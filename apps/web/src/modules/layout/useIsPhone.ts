"use client";

import { useEffect, useState } from "react";

/**
 * 手机宽度（2026-10-05 做 app 第二块：手机排版）。
 * 只在手机上换排版用；电脑上永远是 false —— 电脑上的排版一点不动（「只改外观不改排版」那条红线）。
 */
export const PHONE_QUERY = "(max-width: 640px)";

export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(PHONE_QUERY);
    const sync = () => setIsPhone(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return isPhone;
}
