// 客服对话的浏览器系统通知（2026-10-02 老板选「浏览器系统通知」：客户没开系统页面也能收到新消息提醒）。
// 这是 Service Worker：网页关了它也在，后端推过来的消息由它弹成系统通知（apps/api/src/modules/cs-chat/push.ts 发，
// apps/web/src/modules/cs-chat/chat-push.ts 注册）。
// ⚠️ 只管弹通知和点通知，不拦截网页的任何请求（没有 fetch 处理）—— 不影响系统别的页面怎么加载。

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });

// 苹果（Safari / iPhone 主屏幕网页）规定每条推送都必须弹出来，不弹会被收回推送权限；别家允许「人正在看网页时不弹」
const IS_APPLE = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(self.navigator.userAgent || "");

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  event.waitUntil((async () => {
    if (!IS_APPLE) {
      // 人正对着系统的网页（窗口在最前面）：网页里的红点和「叮咚」已经提醒了，不再弹一个系统通知。
      // 撤回（silent）例外：通知栏里还躺着那条原文（之前不在最前面时弹的）就照样换掉，没有就不用弹
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (wins.some((c) => c.focused)) {
        if (!data.silent) return;
        const old = await self.registration.getNotifications({ tag: data.tag || "cs-chat" });
        if (old.length === 0) return;
      }
    }
    await self.registration.showNotification(data.title || "新消息", {
      body: data.body || "",
      // 同一个对话的通知互相替换（来十条只留最新一条），renotify 让替换时照样响一下。
      // silent = 撤回：把通知栏里那条原文不出声地换成「撤回了一条消息」（2026-10-02）
      tag: data.tag || "cs-chat",
      renotify: !data.silent,
      silent: !!data.silent,
      icon: "/icon.png",
      badge: "/icon.png",
      data: { url: data.url || "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || "/";
  // 只认本站的地址（通知内容是后端给的，这里再兜一道）
  const target = new URL(raw, self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin + "/";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // 已经开着系统的网页：切过去、换到那个对话；没开就新开一个
    for (const c of wins) {
      if (new URL(c.url).origin !== self.location.origin) continue;
      try {
        await c.focus();
        if ("navigate" in c) await c.navigate(url);
        return;
      } catch (e) { /* 这个窗口切不过去，试下一个 */ }
    }
    await self.clients.openWindow(url);
  })());
});
