"use client";

import { useEffect, useState } from "react";
import { APK_PATH, APK_SAVE_AS, APK_SIZE_TEXT, APP_VERSION } from "./app-download";

/**
 * 下载页正文。按打开的地方给一句提醒：
 * - 微信 / QQ 里：它们的内置浏览器不让下载安装包，点了没反应 → 教他换到手机浏览器；
 * - 苹果手机：还没有苹果版；
 * - 已经在湘泰 app 里：不用再装。
 */
type Where = "browser" | "wechat" | "iphone" | "app";

function detect(ua: string): Where {
  if (ua.includes("XiangtaiApp/")) return "app";
  if (/MicroMessenger|\bQQ\//i.test(ua)) return "wechat";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iphone";
  return "browser";
}

const NOTICE: Record<Exclude<Where, "browser">, string> = {
  wechat: "微信 / QQ 里点下载没反应：点右上角「···」，选「在浏览器打开」，再点下面的按钮。",
  iphone: "苹果手机的 app 还在做。现在请用 Safari 打开 xianlianth.com 登录使用。",
  app: "你现在就在湘泰物流 app 里，不用再装。",
};

export default function AppDownloadView() {
  const [where, setWhere] = useState<Where>("browser");
  useEffect(() => {
    setWhere(detect(navigator.userAgent));
  }, []);

  return (
    <main className="app-dl">
      <div className="app-dl-card">
        <img className="app-dl-logo" src="/icon.png" alt="" width={72} height={72} />
        <h1 className="app-dl-title">湘泰物流 app</h1>
        <p className="app-dl-meta">安卓手机 · 版本 {APP_VERSION} · {APK_SIZE_TEXT}</p>
        {where !== "browser" ? <p className="app-dl-notice" role="status">{NOTICE[where]}</p> : null}
        {where === "app" || where === "iphone" ? null : (
          <>
            <a className="app-dl-button" href={APK_PATH} download={APK_SAVE_AS}>下载安卓 app</a>
            <ol className="app-dl-steps">
              <li>点「下载安卓 app」，下载完点开这个安装包。</li>
              <li>手机提示「来源未知」或「有风险」时，选「允许」或「继续安装」（只有第一次会问）。</li>
              <li>装好后桌面上多一个「湘泰物流」，打开就是登录页；登录一次以后再打开直接进。</li>
            </ol>
          </>
        )}
        <p className="app-dl-foot">网站更新时 app 自动跟着更新，不用重装。不想装 app 也可以直接 <a href="/login">用网页登录</a>。</p>
      </div>
    </main>
  );
}
