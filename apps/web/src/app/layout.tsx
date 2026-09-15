import type { Metadata } from "next";
import type { ReactNode } from "react";
import { EARLY_TAB_BRAND_SCRIPT } from "../modules/branding/early-tab-brand";
import WorkbenchFrame from "../modules/layout/WorkbenchFrame";
import "./globals.css";
import "./ledger.css";

export const metadata: Metadata = {
  title: "湘泰物流网站",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        {/*
          代理的客户 / 代理本人整页打开、刷新工作台时，标签页标题和图标第一帧就是代理的（5.2）。
          浏览器解析到这里就同步跑，早于第一次绘制；湘泰账号、没登录、登录页一行不改。详见 early-tab-brand.ts。
          内容是写死在代码里的常量字符串，不含任何请求 / 用户数据。CSP 的 script-src 已放行 'unsafe-inline'（next.config.ts）。
        */}
        <script dangerouslySetInnerHTML={{ __html: EARLY_TAB_BRAND_SCRIPT }} />
      </head>
      <body>
        {/* 工作台外壳（左边菜单）挂在这里，换页时不卸载；非工作台路径原样渲染 */}
        <WorkbenchFrame>{children}</WorkbenchFrame>
      </body>
    </html>
  );
}
