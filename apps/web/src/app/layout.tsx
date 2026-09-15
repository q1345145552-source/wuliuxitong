import type { Metadata } from "next";
import type { ReactNode } from "react";
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
      <body>
        {/* 工作台外壳（左边菜单）挂在这里，换页时不卸载；非工作台路径原样渲染 */}
        <WorkbenchFrame>{children}</WorkbenchFrame>
      </body>
    </html>
  );
}
