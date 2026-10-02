/**
 * 客服对话的浏览器系统通知（2026-10-02 老板选「浏览器系统通知」：客户没开系统页面也能收到新消息提醒）。
 * 后端见 apps/api/src/modules/cs-chat/push.ts；弹通知的是 public/push-sw.js（Service Worker，页面关了它也在）。
 *
 * 开通知：要人自己点一次「开启通知」（浏览器规定：问权限必须是人点出来的）→ 浏览器问「允许通知吗」→
 *   注册 push-sw.js → 向浏览器的推送服务要一个订阅 → 交给我们后端存起来。
 * 这份订阅属于「这个浏览器」，不属于某个账号，所以要管好「换人」：
 *   · 退出登录：后端那行跟令牌在同一个 /auth/logout 请求里删掉（把 currentChatPushEndpoint 交给它），
 *     浏览器这边同时退订（unsubscribeChatPushInBrowser）—— 公用电脑上下一个人不能收到上一个人的消息提醒；
 *   · 打开页面时（syncChatPushOnLoad）：浏览器里的订阅不是现在这个人开的（换人登录、没走退出就过期了）→ 退掉，
 *     要通知让他自己再点一次；是他开的 → 再交给后端一次（后端那行可能被清过）。
 *   「是谁开的」记在 localStorage 的 xt_chat_push_owner（公司:账号）。
 *
 * 苹果手机：Safari 网页本身不支持，要先「分享 → 添加到主屏幕」，从主屏幕打开才行（iOS 16.4 起）。
 * 主屏幕网页要有 manifest 才算「网页应用」，所以在 iPhone 上这里会给页面补一个 <link rel="manifest">（只补这一处，不影响别的浏览器）。
 */
import type { AuthSession } from "../../auth/auth-session";
import { deleteChatPushSubscription, fetchChatPushKey, saveChatPushSubscription } from "../../services/cs-chat-api";

export type ChatPushRole = "client" | "staff" | "admin";
/**
 * on = 这台设备已经开了；off = 能开还没开；denied = 浏览器里点过「禁止」；
 * ios-install = 苹果手机还没加到主屏幕；unsupported = 这个浏览器不支持；server-off = 服务器没配密钥（页面不显示）
 */
export type ChatPushState = "on" | "off" | "denied" | "ios-install" | "unsupported" | "server-off";

const OWNER_KEY = "xt_chat_push_owner";
/** 向浏览器的推送服务要订阅最多等多久（连不上时 Chrome 会一直不回） */
const SUBSCRIBE_TIMEOUT_MS = 20_000;
const SW_PATH = "/push-sw.js";

function ownerOf(session: Pick<AuthSession, "companyId" | "userId">): string {
  return `${session.companyId}:${session.userId}`;
}
function readOwner(): string {
  try { return window.localStorage.getItem(OWNER_KEY) ?? ""; } catch { return ""; }
}
function writeOwner(v: string): void {
  try { if (v) window.localStorage.setItem(OWNER_KEY, v); else window.localStorage.removeItem(OWNER_KEY); } catch { /* 记不下就算了 */ }
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPad 新系统的 Safari 自称 Mac，靠触屏认出来
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1);
}
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
}

/** 这个浏览器能不能用系统通知（Service Worker + Push + Notification 三样都要有） */
export function chatPushSupported(): boolean {
  return typeof window !== "undefined"
    && typeof navigator !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

/** iPhone 上给页面补 manifest（加到主屏幕后才算网页应用，才能开通知）。客户、员工各一份，打开的起始页不同 */
export function ensureIosManifest(role: ChatPushRole): void {
  if (typeof document === "undefined" || !isIos()) return;
  if (document.querySelector('link[rel="manifest"]')) return;
  const link = document.createElement("link");
  link.rel = "manifest";
  link.href = role === "client" ? "/chat-client.webmanifest" : "/chat-staff.webmanifest";
  document.head.appendChild(link);
}

/** VAPID 公钥（URL 安全的 base64）→ 浏览器订阅要的字节 */
function keyBytes(base64url: string): Uint8Array {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const k = sub.options?.applicationServerKey;
  if (!k) return true; // 老浏览器读不到，当一样
  const a = new Uint8Array(k);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function subJson(sub: PushSubscription): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return null;
  return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } };
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!chatPushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? await reg.pushManager.getSubscription() : null;
}

/** 现在这台设备、这个人的通知是什么状态（显示「开启通知」那一行用） */
export async function readChatPushState(session: AuthSession): Promise<ChatPushState> {
  const role = session.role as ChatPushRole;
  if (!chatPushSupported()) return isIos() && !isStandalone() ? "ios-install" : "unsupported";
  const key = await fetchChatPushKey(role);
  if (!key.enabled || !key.publicKey) return "server-off";
  if (Notification.permission === "denied") return "denied";
  const sub = await currentSubscription();
  // 服务器换过密钥：这份旧订阅已经收不到了，显示「没开」让他重新点
  return sub && Notification.permission === "granted" && readOwner() === ownerOf(session) && sameKey(sub, key.publicKey) ? "on" : "off";
}

/** 点「开启通知」：问权限 → 注册 → 订阅 → 交给后端。返回开完以后的状态 */
export async function enableChatPush(session: AuthSession): Promise<ChatPushState> {
  const role = session.role as ChatPushRole;
  if (!chatPushSupported()) return isIos() && !isStandalone() ? "ios-install" : "unsupported";
  const key = await fetchChatPushKey(role);
  if (!key.enabled || !key.publicKey) return "server-off";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "off";
  const reg = await navigator.serviceWorker.register(SW_PATH, { scope: "/" });
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // 服务器换过密钥：旧订阅用不了，退掉重订
  if (sub && !sameKey(sub, key.publicKey)) { await sub.unsubscribe(); sub = null; }
  if (!sub) {
    /* 浏览器向它自己的推送服务要订阅（Chrome 找谷歌、Edge 找微软、火狐找 Mozilla、Safari 找苹果）。
       2026-10-02 本地实测两种坏情况：
         · 无痕窗口：Chrome 直接报英文「Registration failed - permission denied」；
         · 连不上推送服务：Chrome 一直不回，按钮永远「开启中…」—— 国内用 Chrome 的人连不上谷歌就是这样。
       所以限时 20 秒，报错一律换成看得懂的中文，并告诉他换哪个浏览器。 */
    const timeout = new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("timeout")), SUBSCRIBE_TIMEOUT_MS));
    try {
      sub = await Promise.race([
        reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key.publicKey) as BufferSource }),
        timeout,
      ]);
    } catch (e) {
      throw new Error(e instanceof Error && e.message === "timeout"
        ? "连不上这个浏览器的推送服务，通知没开成。在国内用 Chrome 常遇到这种情况，可以换 Edge 或火狐再试"
        : "这个浏览器现在开不了通知（无痕 / 隐私窗口不支持）。请用普通窗口打开，或者换 Edge / 火狐再试");
    }
  }
  const json = subJson(sub);
  if (!json) throw new Error("浏览器没给出完整的通知订阅，请刷新页面再试");
  await saveChatPushSubscription(role, json);
  writeOwner(ownerOf(session));
  return "on";
}

/** 点「关闭通知」：后端删、浏览器也退掉 */
export async function disableChatPush(session: AuthSession): Promise<ChatPushState> {
  const sub = await currentSubscription();
  if (sub) {
    try { await deleteChatPushSubscription(session.role as ChatPushRole, sub.endpoint); } catch { /* 后端删不掉：浏览器这边退掉以后，下次推送服务回「作废」后端也会删 */ }
    await sub.unsubscribe();
  }
  writeOwner("");
  return "off";
}

/**
 * 打开页面时（左边菜单外壳挂载 / 换人后）调一次：
 *   · 订阅是现在这个人自己开的 → 再交给后端一次（那行可能被清过）；
 *   · 不是他开的（换人登录了）、或者是代理账号 → 浏览器这边退掉，要通知让他自己再点一次。
 * ⚠️ 不按「左边菜单藏没藏客服」来退（品牌是异步查的，查到之前那一下会误判，把正常客户的通知退掉）；
 *    代理名下的客户本来就订不上（后端 403），也收不到（客服发不了消息给他）。
 * 出错一律不打扰人。
 */
export async function syncChatPushOnLoad(session: AuthSession | null): Promise<void> {
  try {
    if (!session || !chatPushSupported()) return;
    const sub = await currentSubscription();
    if (!sub) return;
    const mine = readOwner() === ownerOf(session);
    const canChat = session.role === "client" || session.role === "staff" || session.role === "admin";
    if (!canChat || !mine || Notification.permission !== "granted") {
      await sub.unsubscribe();
      writeOwner("");
      return;
    }
    /* 服务器换过密钥（2026-10-02 复核）：旧密钥订的这份已经收不到了，原来照样每次交给后端、页面还显示「已开启」，
       谁也不会去重新点。现在退掉，页面显示「没开」，他点一下就是新密钥的订阅。服务器没开通知就什么都不动 */
    const key = await fetchChatPushKey(session.role as ChatPushRole);
    if (!key.enabled || !key.publicKey) return;
    if (!sameKey(sub, key.publicKey)) {
      await sub.unsubscribe();
      writeOwner("");
      return;
    }
    const json = subJson(sub);
    if (json) await saveChatPushSubscription(session.role as ChatPushRole, json);
  } catch {
    /* 同步不了就算了，下次打开页面再来 */
  }
}

/**
 * 退出登录用：这台设备的订阅地址（只读浏览器本地，不联网）。没开过通知是 null。
 * 交给 /auth/logout，后端在作废令牌的同一个请求里删掉那一行（2026-10-02 复核：原来单独发一个请求、
 * 等它回来再作废令牌，作废被推迟，网慢时退出请求被跳转掐断，令牌还能用 7 天）。
 */
export async function currentChatPushEndpoint(): Promise<string | null> {
  try {
    return (await currentSubscription())?.endpoint ?? null;
  } catch {
    return null;
  }
}

/**
 * 退出登录用：浏览器这边退订（不联网等后端）。记下的「谁开的」马上清掉。
 * 退订本身可能卡住（国内 Chrome 连不上谷歌）—— 调用方别等它，后端那行已经跟着退出删了。
 */
export async function unsubscribeChatPushInBrowser(): Promise<void> {
  writeOwner("");
  try {
    const sub = await currentSubscription();
    if (sub) await sub.unsubscribe();
  } catch {
    /* 退不掉也不能卡住退出 */
  }
}
