/**
 * 客服对话的浏览器系统通知（Web Push，2026-10-02 老板选「浏览器系统通知」）。
 *
 * 要解决的：原来红点、提示音都只在系统页面开着时才有 —— 客户没开系统，客服回了他也不知道。
 * 现在客户 / 员工在聊天页点一次「开启通知」，之后只要浏览器开着（页面关了也行），
 * 来新消息就在电脑右下角 / 手机通知栏弹一条。
 *
 * 发给谁：客户发的 → 本公司所有开了通知的员工 / 超管（共用收件箱）；客服发的 → 那个客户。
 * 怎么发：浏览器给的推送地址（谷歌 / 火狐 / 苹果 / 微软各家的推送服务）+ 我们的 VAPID 密钥签名，内容加密，推送服务看不到内容。
 *   用 web-push 这个库（加密和签名都是它做，别自己写）。
 *
 * ⚠️ 要在服务器 .env 里配好三项才会开（没配就整个功能不出现，页面上不显示「开启通知」）：
 *    VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY（成对的，用 `npx web-push generate-vapid-keys` 生成一次，以后别换 ——
 *    换了所有人已经开的通知全部失效，要重新点一次）、VAPID_SUBJECT（mailto:你的邮箱，推送服务出问题时联系用）。
 *    docker-compose.yml 的 api 那段要透传这三项，不然改了 .env 进不了容器。
 * ⚠️ 服务器要能连上各家推送服务（fcm.googleapis.com、web.push.apple.com …）。服务器在中国大陆的话，
 *    谷歌那家连不上：安卓 Chrome、电脑 Chrome / Edge 收不到，苹果、火狐不受影响。
 *
 * 发送是「发完消息以后顺手发」，不等它、不影响发消息本身；推送服务说这个地址作废了（404 / 410）就删掉那一行。
 */
import { createHash } from "node:crypto";
import { parse as legacyParseUrl } from "node:url";
import webpush from "web-push";
import { prisma } from "../../db/prisma";
import { logger } from "../core/logger";
import { passwordFingerprint } from "../auth/token";

export type PushConfig = { publicKey: string; privateKey: string; subject: string };

/** 读服务器配置；三项缺一项就当没开（返回 null） */
export function readPushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig | null {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (env.VAPID_PRIVATE_KEY ?? "").trim();
  const subject = (env.VAPID_SUBJECT ?? "").trim();
  if (!publicKey || !privateKey || !/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

/**
 * 只认各家浏览器推送服务的地址（2026-10-02）。
 * 为什么要卡：推送地址是浏览器交上来的，等于「服务器以后会往这个网址发请求」——
 * 不卡的话，有人手拼一个内网地址交上来，每来一条消息服务器就替他往内网发一次请求（SSRF）。
 * 名单：谷歌（Chrome / 安卓 / Opera / 三星）、火狐、苹果（Safari / iPhone 主屏幕网页）、微软（Edge 老通道）。
 *
 * ⚠️ 两种解析器都要过、而且要一致（2026-10-02 独立复审实测绕过）：这里原来只用 new URL 看主机名，
 *    web-push 真发请求时用的却是 Node 老的 url.parse —— 两个对怪字符的切法不一样。
 *    「https://10.0.0.5;x.push.apple.com/」在 new URL 眼里主机是「10.0.0.5;x.push.apple.com」（以 .push.apple.com 结尾，放行），
 *    在 url.parse 眼里主机是 10.0.0.5 —— 每来一条消息服务器就往内网发一次请求。
 *    所以：主机名只许字母数字点横杠，两个解析器读出来的协议、主机、端口必须一模一样。
 */
const PUSH_HOSTS_EXACT = ["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
const PUSH_HOST_SUFFIXES = [".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];
const STRICT_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function isAllowedPushEndpoint(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" || (u.port !== "" && u.port !== "443") || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (!STRICT_HOST_RE.test(host)) return false;
  // web-push 发请求时就是按这个解析的（node_modules/web-push/src/web-push-lib.js）：它读出来的必须跟上面一样
  let legacy: ReturnType<typeof legacyParseUrl>;
  try { legacy = legacyParseUrl(raw); } catch { return false; }
  if (legacy.protocol !== "https:" || (legacy.hostname ?? "").toLowerCase() !== host || (legacy.port !== null && legacy.port !== "443") || legacy.auth) return false;
  return PUSH_HOSTS_EXACT.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

export type PushSubscriptionInput = { endpoint: string; p256dh: string; auth: string };

/** 校验浏览器交上来的订阅；通过返回整理好的，不通过返回给人看的原因 */
export function parsePushSubscription(body: unknown): PushSubscriptionInput | { error: string } {
  const b = (body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null };
  const endpoint = typeof b.endpoint === "string" ? b.endpoint.trim() : "";
  const p256dh = typeof b.keys?.p256dh === "string" ? b.keys.p256dh.trim() : "";
  const auth = typeof b.keys?.auth === "string" ? b.keys.auth.trim() : "";
  if (!endpoint || endpoint.length > 1000 || !isAllowedPushEndpoint(endpoint)) return { error: "这个浏览器的通知地址不认识，请换 Chrome / Edge / Safari / 火狐再试" };
  // 两把钥匙都是 URL 安全的 base64（p256dh 65 字节 ≈ 87 个字，auth 16 字节 ≈ 22 个字），放宽一点但不收乱码
  if (!/^[A-Za-z0-9_-]{20,200}={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]{10,100}={0,2}$/.test(auth)) return { error: "通知订阅的内容不对，请刷新页面再点一次" };
  return { endpoint, p256dh, auth };
}

/** 一条通知的内容（推送服务转给浏览器，public/push-sw.js 弹出来） */
export type PushPayload = {
  title: string;
  body: string;
  /** 点通知打开哪一页 */
  url: string;
  /** 同一个对话的通知互相替换（来十条不弹十个） */
  tag: string;
  /** 不出声地替换（撤回时用：把通知栏里那条原文换掉，不再响一次） */
  silent?: boolean;
};

type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type PushSender = (target: PushTarget, payload: string, options: { topic: string; config: PushConfig }) => Promise<{ statusCode: number }>;

const realSender: PushSender = async (target, payload, { topic, config }) => {
  const r = await webpush.sendNotification(
    { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
    payload,
    {
      vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
      // 浏览器关着时推送服务替我们存一天，开了再送；超过一天的提醒没意义了
      TTL: 24 * 60 * 60,
      urgency: "high",
      topic,
      timeout: 10_000,
    },
  );
  return { statusCode: r.statusCode };
};

let sender: PushSender = realSender;
let configOverride: PushConfig | null | undefined;
const pending = new Set<Promise<void>>();

/** 只给测试用：换掉真发送（测试环境连不上各家推送服务），配置也可以直接给 */
export function setPushSenderForTest(s: PushSender | null, config?: PushConfig | null): void {
  sender = s ?? realSender;
  configOverride = s ? config : undefined;
}
/** 只给测试用：等手头正在发的通知都发完 */
export async function waitForPushesForTest(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

export function currentPushConfig(): PushConfig | null {
  return configOverride !== undefined ? configOverride : readPushConfig();
}

/**
 * 同一个对话的通知用同一个 topic：浏览器关着时，推送服务里只留最新那一条（不攒一堆）。
 * topic 最长 32 个字、只许 URL 安全的 base64 字符 —— 拿对话的键做个哈希。
 */
export function pushTopic(key: string): string {
  return createHash("sha256").update(key).digest("base64url").slice(0, 32);
}

/** 通知正文：摘要最长 80 个字（按「字」截，不劈表情） */
function clip(text: string, max = 80): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

type StoredSubscription = { endpoint: string; p256dh: string; auth: string; userId: string; companyId: string; role: string; passwordFp: string };

/**
 * 订阅还算不算数：每次发之前按账号**现在**的样子核一遍（2026-10-02 独立复审）。
 * 订阅一存就是好几个月，原来只按公司、角色找人 —— 员工离职被封号、客户怀疑被盗改了密码，
 * 登录状态当场失效（session-guard.ts），但那台设备照样一直收到客户的唛头和消息摘要。现在跟登录同一套标准：
 *   · 账号还在、还是 active（封号 = 不收）；
 *   · 角色没变（存订阅时是什么角色就只按什么角色收）；
 *   · 密码没换过（存订阅时记下密码指纹，跟登录令牌里的 pv 同一个算法；改了密码，小偷那台设备上的订阅就作废）；
 *   · 客户：没被划到代理名下（代理的客户不开对话）；
 *   · 地址还在名单里（存进来以后名单收紧了也照样挡）。
 * 不算数的直接删掉（这个人自己的设备下次打开系统会自动重新登记，见前端 chat-push.ts 的 syncChatPushOnLoad）。
 */
async function filterLiveSubscriptions(subs: StoredSubscription[]): Promise<StoredSubscription[]> {
  if (subs.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(subs.map((x) => x.userId))] } },
    select: { id: true, companyId: true, role: true, status: true, agentId: true, passwordHash: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  const live: StoredSubscription[] = [];
  const dead: string[] = [];
  for (const sub of subs) {
    const u = byId.get(sub.userId);
    const ok = !!u
      && u.companyId === sub.companyId
      && u.status === "active"
      && u.role === sub.role
      && (u.role !== "client" || u.agentId === null)
      && passwordFingerprint(u.passwordHash) === sub.passwordFp
      && isAllowedPushEndpoint(sub.endpoint);
    if (ok) live.push(sub); else dead.push(sub.endpoint);
  }
  if (dead.length > 0) await prisma.csPushSubscription.deleteMany({ where: { endpoint: { in: dead } } });
  return live;
}

/**
 * 发完一条消息后调：按发的人决定推给谁。不等结果、不抛错（推送失败不影响聊天）。
 * fromRole = client → 本公司员工 / 超管；staff / admin → 这个客户。
 * recall = 撤回（2026-10-02 独立复审）：撤回的是最新那条时调 —— 用同一个 tag 不出声地把通知栏里那条原文换成「撤回了一条消息」，
 *   不然发错了人、两秒内撤回，原文照样躺在对方手机的通知栏里。
 */
export function notifyChatMessage(opts: { companyId: string; clientId: string; fromRole: string; preview: string; recall?: boolean }): void {
  const config = currentPushConfig();
  if (!config) return;
  const toClient = opts.fromRole !== "client";
  const base: PushPayload = toClient
    ? { title: "客服给你发来消息", body: clip(opts.preview), url: "/client/chat", tag: "cs-self" }
    : { title: `客户 ${opts.clientId}`, body: clip(opts.preview), url: `/staff/chat?clientId=${encodeURIComponent(opts.clientId)}`, tag: `cs-c-${opts.clientId}` };
  const payload: PushPayload = opts.recall
    ? { ...base, title: toClient ? "客服" : `客户 ${opts.clientId}`, body: "撤回了一条消息", silent: true }
    : base;
  const job = (async () => {
    const stored = await prisma.csPushSubscription.findMany({
      where: toClient
        ? { companyId: opts.companyId, userId: opts.clientId, role: "client" }
        : { companyId: opts.companyId, role: { in: ["staff", "admin"] } },
      select: { endpoint: true, p256dh: true, auth: true, userId: true, companyId: true, role: true, passwordFp: true },
    });
    const targets = await filterLiveSubscriptions(stored);
    const topic = pushTopic(`${opts.companyId}:${opts.clientId}:${toClient ? "c" : "s"}`);
    const body = JSON.stringify(payload);
    await Promise.all(targets.map(async (t) => {
      try {
        await sender({ endpoint: t.endpoint, p256dh: t.p256dh, auth: t.auth }, body, { topic, config });
      } catch (e: any) {
        const status = typeof e?.statusCode === "number" ? e.statusCode : 0;
        if (status === 404 || status === 410) {
          // 这个浏览器把通知关了 / 换了订阅：地址作废，删掉
          await prisma.csPushSubscription.deleteMany({ where: { endpoint: t.endpoint } });
          return;
        }
        // 只记推送服务是哪家，不记完整地址（地址等于这个浏览器的收件箱）
        let host = "";
        try { host = new URL(t.endpoint).hostname; } catch { /* 记不下就算了 */ }
        logger.warn("客服对话系统通知没发出去", { host, status, error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) });
      }
    }));
  })().catch((e) => {
    logger.warn("客服对话系统通知出错", { error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) });
  });
  pending.add(job);
  void job.finally(() => pending.delete(job));
}
