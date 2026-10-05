import type { Metadata } from "next";
import { notFound } from "next/navigation";
import AppDownloadView from "../../modules/app-shell/AppDownloadView";
import { getBrandByLoginCookie, getBrandByRequestHost } from "../../modules/branding/server-brand";

/**
 * 安卓 app 下载页：xianlianth.com/app（2026-10-05 老板选「C」：网站放下载页 + 他自己发文件）。
 * 谁都能打开，不用登录。app 名字、图标是湘泰的，所以代理的专属域名、以及在这台设备上登录过的前缀代理的客户
 * （cookie 记着）都不出这一页（照代理品牌规矩，那边不露湘泰；跟 /login /register 同一条认法）。
 * 「app」「download」已加进代理前缀保留字（apps/api/src/modules/agents/agent-rules.ts）。
 */
export const metadata: Metadata = {
  title: "湘泰物流 app 下载",
};

export default async function AppDownloadPage() {
  if ((await getBrandByRequestHost()) ?? (await getBrandByLoginCookie())) notFound();
  return <AppDownloadView />;
}
