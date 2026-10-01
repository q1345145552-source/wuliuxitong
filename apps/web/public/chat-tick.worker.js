// 客服对话提示音的「计时器」（2026-10-02 老板：「当时收的时候响，而不是之后响」）。
// 网页在后台待久了，浏览器会把页面自己的定时器放慢到一分钟一次；Worker 里的定时器不受这个限制。
// 页面发来间隔（毫秒），这里按这个间隔给页面发一个「到点了」，页面收到再去问有没有新消息（useChatUnread.ts）。
let timer = null;
self.onmessage = (e) => {
  const ms = Number(e.data) > 0 ? Number(e.data) : 5000;
  if (timer) clearInterval(timer);
  timer = setInterval(() => self.postMessage(1), ms);
};
