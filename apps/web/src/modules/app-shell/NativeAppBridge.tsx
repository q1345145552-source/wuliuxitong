"use client";

import { useEffect } from "react";
import { installNativeApp } from "./native-app";

/** 根布局挂一个：在湘泰 app 里打开时，接上存文件 / 开新窗口 / 打印 / 返回键（见 native-app.ts）；浏览器里什么都不做 */
export default function NativeAppBridge() {
  useEffect(() => {
    installNativeApp();
  }, []);
  return null;
}
