/**
 * 对外（客户 / 免登录）下发数据前的脱敏。**唯一定义处。**
 *
 * 用户红线：**客户不能看到柜号。**
 *
 * 柜号会从三条缝里漏出去，堵一条不够：
 *   ① 字段：shipments.batchNo、containers[].containerNo —— 直接就是柜号
 *   ② 正文：装柜时写的轨迹备注是「装入柜子 SELU4640250（分装 30件）」，柜号藏在句子里；
 *      **还有一种**：事后补建柜子时写的「到达凭祥口岸（随柜 L2608219129 补记）」——
 *      2026-08-29 上线前排查才发现这种一直没堵（生产实测 9 条轨迹 / 3 张运单在漏）
 *   ③ 免登录查轨迹：连账号都不用，只要运单号 + 手机后 4 位
 *
 * ⚠️ 2026-08-11 审出来的：①③ 两条一直没堵 ——
 *    /client/shipments/search 照发 batchNo（19 张运单 / 8 个客户），
 *    /public/track 照发 batchNo 且备注原样下发（136 张运单 / 21 个客户）。
 *    「前端不显示」不算堵住 —— 数据到了浏览器就是泄漏，开发者工具一开就能看到。
 *    **对外接口一律不下发，而不是让前端别显示。**
 */

/**
 * 把轨迹备注里的柜号抹掉，只留「已装柜」和后面的分装件数。
 *
 * 柜号后面可能紧跟「（分装 N件）」，中间没有空格，
 * 所以匹配到括号就停，别把后半句一起吃掉。
 *
 * @param remark 原始备注
 * @param hide   true=对外（客户/免登录），要抹；false=内部（员工/管理员），原样返回
 */
/** 正则转义 —— 柜号里可能有 . - 之类的字符，直接拼进正则会变成通配 */
function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 国际标准柜号（ISO 6346）：3 个字母 + U/J/Z + 6 位数字 + 1 位校验码，中间偶尔带个空格。
 * 员工手写、系统里没录过的海运柜号靠这一条认（2026-09-28 Codex 复核：卸柜会删掉柜内记录，
 * 原来那个柜号就不在「这票货装过的柜」名单里了，之前备注里写的柜号会重新露出来）。
 * 生产库只读核过（2026-09-28）：运单号没有一个长这样（SZ / YW / GZ / JL 开头），不会误抹。
 */
const ISO_CONTAINER_NO_RE = /\b[A-Z]{3}[UJZ]\s?\d{6}\s?\d\b/gi;

/** 同一份柜号清单（同一个数组）只编译一次：客户运单列表一次要抹几千条备注，柜号几百个 */
const matcherCache = new WeakMap<readonly string[], RegExp | null>();
function containerNosMatcher(list: readonly string[]): RegExp | null {
  if (matcherCache.has(list)) return matcherCache.get(list) ?? null;
  const parts = [...new Set(list.map((no) => String(no ?? "").trim()).filter((no) => no.length >= 4))]
    // 长的排前面：一个柜号是另一个的前缀时先把长的整个抹掉
    .sort((a, b) => b.length - a.length)
    .map(escapeForRegExp);
  const re = parts.length > 0 ? new RegExp(parts.join("|"), "gi") : null;
  matcherCache.set(list, re);
  return re;
}

export function sanitizeRemarkForClient(remark: string, hide: boolean, containerNos: readonly string[] = []): string {
  if (!hide) return remark;
  /* ③ ⚠️ **按真实柜号精确抹一遍**（2026-09-24 复核抓到，Codex 报的，实测确认）。
     上面①②那两条正则只认「装入柜子 XXX」和「（随柜 XXX 补记）」两种**固定写法**。
     可员工推状态时那个备注框是**随便写的**，写成「柜号 MEDU1234567 已开船」
     或者干脆只填个柜号，两条正则一条都认不出来，原样就发给客户了
     （2026-09-24 测试库实测：备注和「下一站」两处都漏）。
     所以调用方把这票货真实装的柜号传进来，按号精确抹 —— 不猜写法，只认号。
     太短的号不抹：3 个字符以下容易误伤正常文字。
     2026-09-28 起调用方传的是「这票货的柜 + 本公司全部柜号」（core/container-nos.ts），
     再加一道按标准柜号样子认（ISO_CONTAINER_NO_RE），接住手写的、系统里没录过的。 */
  let out = remark;
  const matcher = containerNosMatcher(containerNos);
  if (matcher) out = out.replace(matcher, "柜号已隐藏");
  out = out.replace(ISO_CONTAINER_NO_RE, "柜号已隐藏");
  return (
    out
      // ① 装柜当时写的：「装入柜子 SELU4640250（分装 30件）」
      .replace(/装入柜子\s*[^\s（(]+/g, "已装柜")
      /**
       * ② ⚠️ **随柜补记的那种**（2026-08-29 上线前排查补的）。
       *
       * 员工事后补建柜子时，系统会给这票货补一串历史轨迹，备注写成
       *   「到达凭祥口岸（随柜 L2608219129 补记）」
       *   「已封柜（随柜 L2608219129 补记）」
       * 柜号就夹在这句话里。上面①那条正则只认「装入柜子 XXX」这一种写法，
       * **认不出这一种**，于是原样发给了客户。
       *
       * 生产库只读实测（2026-08-29）：**9 条轨迹、3 张运单**正在漏，
       * 客户在「我的订单」和「查轨迹」两个地方都看得到。
       * 这是上线前就存在的老洞，不是这次改动弄坏的，顺手一起堵上。
       *
       * 抹成「（随柜补记）」而不是整段删掉 —— 客户需要知道
       * 「这条是事后补的，不是实时记录」，那个信息本身没问题。
       */
      .replace(/（随柜\s*[^\s）)]+\s*补记）/g, "（随柜补记）")
      .replace(/\(随柜\s*[^\s）)]+\s*补记\)/g, "（随柜补记）")
  );
}
