import type { Metadata } from "next";
import { redirect } from "next/navigation";
import LoginView from "../../modules/branding/LoginView";
import { BRAND_LOGIN_COOKIE, brandLoginRedirectPath, normalizeBrandSlug } from "../../modules/branding/brand-core";
import { getBrandByRequestHost, getBrandBySlug, readBrandLoginCookie } from "../../modules/branding/server-brand";

/**
 * 登录页（2026-09-16 起是服务端组件，表单本身在 modules/branding/LoginView.tsx，内容没改）。
 *
 * 为什么要到服务端：
 * ① 代理的专属域名（5.1/5.5）：按请求的 Host 查代理品牌，第一屏就是代理的名字，不闪湘泰；
 * ② 代理的客户退出登录 / 登录过期都会被送到 /login：cookie 里记着他是哪个代理的（进工作台时记的），
 *    在服务端直接转去代理自己的前缀登录页 /<slug>。
 * 湘泰自己（湘泰域名、没有那个 cookie）：两样都查不到，渲染出来跟以前一模一样。
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrandByRequestHost();
  // 湘泰自己返回空对象 = 沿用根布局的「湘泰物流网站」
  return brand ? { title: brand.name } : {};
}

function toSearch(params: Record<string, string | string[] | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") qs.append(key, value);
    else if (Array.isArray(value)) value.forEach((v) => qs.append(key, v));
  }
  const text = qs.toString();
  return text ? `?${text}` : "";
}

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const hostBrand = await getBrandByRequestHost();
  if (hostBrand) return <LoginView brand={hostBrand} slug={null} />;

  const cookieSlug = normalizeBrandSlug(await readBrandLoginCookie(BRAND_LOGIN_COOKIE));
  // 前缀还得真存在（代理改了前缀 / 被删）才转，不然转过去是 404，人就卡死了
  if (cookieSlug && (await getBrandBySlug(cookieSlug))) {
    const target = brandLoginRedirectPath(cookieSlug, toSearch(await searchParams));
    if (target) redirect(target);
  }
  return <LoginView brand={null} slug={null} />;
}
