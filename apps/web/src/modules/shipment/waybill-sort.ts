/**
 * 「运单管理」列表怎么排（员工页、管理员页共用）。
 *
 * 2026-11-23 老板：「怎么物流系统的不是按运单的时间来排序的？」原来两页都是「按运单号里的数字从大到小」：
 * 各仓号码长短不一（东莞 JL20260701-3051 有 12 位数字、义乌 YW0001912 只有 4 位），
 * 东莞那批老单一直霸在最上面，当天新建的义乌单排到两千多位（线上 3346 张里第 2634 位）。
 * 给他 A「按到仓日期」/ B「按录入时间」，他选 A：
 *   ① 到仓日期（订单的 shipDate，编辑框里那个日期）新的在上面；
 *   ② 同一天到仓的，录入系统晚的在上面（createdAt）；
 *   ③ 还一样（拆出来的子单跟父单同一张订单，两个时间都一样）按原来的运单号从大到小，保证每次刷新顺序不跳。
 * 没填到仓日期 / 开头不是真实存在的「年-月-日」（2026-02-31、2026-99-99 这种；核真实日子的办法同后端 orders/routes.ts 的 isRealYmd，
 *   但只看开头 10 位、比它宽松，带时间的旧值也认）排最后。
 *   不存在的日子那一列照原样显示（留给人看见去改，线上 11-23 一张都没有），排序当没填 —— 没有「那一天」可排。
 * 填错年份的（线上有 0026-08-07、2026-12-30 这种手误）照填的排、不替它改 —— 改数据在编辑框里改到仓日期。
 *
 * ⚠️ 排的日期必须跟那一页「到仓日期」那一列显示的是同一个（dsh 11-23 第 1 轮）：
 *    员工页那一列只显示 shipDate → compareWaybillsByArrival；
 *    管理员页那一列没填时退到建单日期（待入库除外，见 export-filter.ts 的 adminArrivedDate）→ 管理员页用
 *    waybillArrivalComparator(adminArrivedDate)。不然一张没填到仓日期的单显示「2026-11-23」却排到最后，看着又是乱的。
 */

export type WaybillSortFields = {
  shipDate?: string | null;
  createdAt?: string | null;
  trackingNo?: string | null;
};

/** 到仓日期只认开头真实存在的「YYYY-MM-DD」（库里是字符串列）；别的一律当没填。不靠 new Date 顺延（2-31 会滚成 3-3） */
function arrivalDay(day: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((day ?? "").trim());
  if (!m) return "";
  const text = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${text}T00:00:00.000Z`);
  const real = !Number.isNaN(d.getTime()) && d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]);
  return real ? text : "";
}

function createdMs(createdAt: string | null | undefined): number | null {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  return Number.isFinite(t) ? t : null;
}

/**
 * 原来的「按运单号数字从大到小」，现在只当最后一道兜底。
 * 【审查问题 10】不用 Number()（超 15 位丢精度）：先比位数、再按字符串比 —— 等长纯数字的字典序就是数值序。
 */
export function compareTrackingNoDesc(a: string | null | undefined, b: string | null | undefined): number {
  const an = (a ?? "").replace(/\D/g, "").replace(/^0+/, "");
  const bn = (b ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (an.length !== bn.length) return bn.length - an.length;
  if (an !== bn) return bn < an ? -1 : 1;
  // 数字一样（只差前缀，比如 SZ / GZ 撞号）：按整串比，顺序固定
  const as = a ?? "";
  const bs = b ?? "";
  return as === bs ? 0 : bs < as ? -1 : 1;
}

/**
 * 做一个给 Array.prototype.sort 用的比较函数（排在前面的返回负数）。
 * dayOf：这一页「到仓日期」那一列显示的日期（见文件头 ⚠️）。
 */
export function waybillArrivalComparator<T extends WaybillSortFields>(dayOf: (row: T) => string | null | undefined): (a: T, b: T) => number {
  /* 每张单的「哪一天 / 录入毫秒」算一次记住（11-23 拿线上 3344 张实测：每比一次都现算要 16 毫秒，老排法 3 毫秒）。
     按这一行对象记（WeakMap：列表每次重拉都是新对象，旧的跟着被回收）；原始值变了就重算，同一个对象被改过也不会用旧的 */
  const keys = new WeakMap<T, { rawDay: string | null | undefined; rawCreated: string | null | undefined; day: string; ms: number | null }>();
  const keyOf = (row: T) => {
    const rawDay = dayOf(row);
    const rawCreated = row.createdAt;
    let k = keys.get(row);
    if (!k || k.rawDay !== rawDay || k.rawCreated !== rawCreated) {
      k = { rawDay, rawCreated, day: arrivalDay(rawDay), ms: createdMs(rawCreated) };
      keys.set(row, k);
    }
    return k;
  };
  return (a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    const ad = ka.day;
    const bd = kb.day;
    if (ad !== bd) {
      if (!ad) return 1; // 没填的排最后
      if (!bd) return -1;
      return ad < bd ? 1 : -1; // 新的在上
    }
    const ac = ka.ms;
    const bc = kb.ms;
    if (ac !== bc) {
      if (ac === null) return 1;
      if (bc === null) return -1;
      return bc - ac; // 晚录入的在上
    }
    return compareTrackingNoDesc(a.trackingNo, b.trackingNo);
  };
}

/** 员工页：「到仓日期」那一列只显示 shipDate */
export const compareWaybillsByArrival = waybillArrivalComparator<WaybillSortFields>((row) => row.shipDate);
