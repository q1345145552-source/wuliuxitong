import type { Metadata } from "next";
import { notFound } from "next/navigation";
import LoginView from "../../modules/branding/LoginView";
import { normalizeBrandSlug } from "../../modules/branding/brand-core";
import { getBrandBySlug } from "../../modules/branding/server-brand";

/**
 * 代理的前缀登录页：网址/<前缀>（确认单 5.1 / 5.5，2026-09-16 B4）。
 *
 * ⚠️ 为什么敢用根目录的动态段（实测结论写在 docs 报告里）：
 * · 现有页面（/login /register /admin /staff /client /agent /forbidden）是静态路由，永远先匹配；
 * · next.config.ts 的 rewrites 是数组写法 = afterFiles，在「动态路由」之前生效，
 *   /auth/xxx /admin/xxx /images/xxx 这些转发到后端的请求轮不到这里；
 * · 这个段只吃一层（/abc），两层以上（/abc/def）本来就不归它。
 * 代理前缀不许用保留字（admin staff client agent login register auth images 等），代理管理开代理时卡。
 *
 * 前缀格式不对 / 查不到 → 404（跟以前打错地址一样）。
 */

type Params = Promise<{ agentSlug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { agentSlug } = await params;
  const brand = await getBrandBySlug(agentSlug);
  // ⚠️ 实测（生产构建）：打错的前缀显示的是 404 页面，但 HTTP 状态码是 200（Next 流式渲染先发了 200，
  // 官方文档 not-found.md 写明这是设计如此，要真 404 只能在 proxy 里查）。页面自带 noindex，对人没区别。
  // 以前打错一层地址（如 /abc）是真 404；这是这次唯一的行为差别，写进了报告。
  if (!brand) notFound();
  return { title: brand.name };
}

export default async function AgentLoginPage({ params }: { params: Params }) {
  const { agentSlug } = await params;
  const slug = normalizeBrandSlug(agentSlug);
  if (!slug) notFound();
  const brand = await getBrandBySlug(slug);
  if (!brand) notFound();
  return <LoginView brand={brand} slug={slug} />;
}
