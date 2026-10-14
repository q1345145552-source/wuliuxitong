/**
 * 请求门闩（2026-09-01，Codex 竞态全扫后统一引入）。
 *
 * 治的病：「异步取数 → setState」期间用户换了上下文（切分组/翻页/换选中项/改搜索词），
 * 晚到的旧响应把新界面盖掉——老板实测抓到的「亮着在途、列表却是全量」就是这病，
 * 全系统同类入口有 24 处（见 docs/codex-竞态修复复查提示词-2026-09-01.md 那轮复核）。
 *
 * 用法一（列表/筛选类，「只认最新一次请求」）：
 *   const gate = useRef(createRequestGate()).current;
 *   const load = async () => {
 *     const ticket = gate.begin();          // 出发时领号
 *     try {
 *       const data = await fetchXxx(...);
 *       if (!gate.isCurrent(ticket)) return; // 回来发现号作废：数据、报错、loading 都不许碰
 *       setList(data);
 *     } catch (e) {
 *       if (!gate.isCurrent(ticket)) return; // ⚠️ 失败分支同样要挡（错误提示也不许安错地方）
 *       setMessage(...);
 *     } finally {
 *       if (gate.isCurrent(ticket)) setLoading(false); // ⚠️ 旧请求不许提前掐掉新请求的加载态
 *     }
 *   };
 *
 * 用法二（详情/弹窗类，「数据要认对主人」）：响应回来时比对「当前选中的 id」
 * 还是不是出发时那个（用 useRef 存最新选中值），不是就整段 return。
 * 两种可以叠加：先核号、再核主人。
 *
 * ⚠️ 用法一之前先认主人（2026-09-02 三审整改补）：过期上下文的刷新不许领号。
 *    加载函数带上下文参数（如 loadDetail(taskId)）时，进门第一行就要核对
 *    「参数 === 当前选中的 ref」，不是就整个 return——不领号、不开 loading、不清数据。
 *    否则旧上下文（比如任务 A 的操作完成回调）晚来的刷新一领号，就把新上下文 B
 *    还在路上的请求作废了，而它自己的响应又过不了主人核对被丢弃，B 页面就空白。
 *    先认主人再领号，旧上下文的刷新对新上下文零影响。
 *
 * ⚠️ 每一份独立的数据上下文用**自己**的门闩（列表一个、详情一个、图片一个），
 *    共用一个门闩会让不相关的请求互相作废。
 */
export interface RequestGate {
  /** 出发时领号：本次请求的号 */
  begin(): number;
  /** 响应落地时验号：还是最新一次吗？ */
  isCurrent(ticket: number): boolean;
  /** 作废在路上的全部请求（关弹窗 / 组件卸载时用）：之后回来的响应一律验号不过 */
  cancel(): void;
}

export function createRequestGate(): RequestGate {
  let seq = 0;
  return {
    begin: () => ++seq,
    isCurrent: (ticket: number) => ticket === seq,
    cancel: () => { seq += 1; },
  };
}

/**
 * 用法三（列表 + 后台静默刷新拉的是同一份数据，2026-10-14 全系统审查 Codex 第 2 轮）：
 * 用法一「只认最新一次」在这里会出事 —— 员工刚按新条件查（前台），实时推送又触发一次静默刷新（后台），
 * 后台那次排在后面领号，前台成功回来验号不过被扔掉；后台那次偏偏失败了、又不报错，列表就停在上一个条件。
 * 这里改成：**成功**回来的结果，只要还是「现在的查询条件」、而且不比已经显示的那份旧，就用；失败的请求谁也不作废。
 *   const gate = useRef(createQueryGate<Cond>()).current;
 *   const t = gate.begin(cond);                         // 出发时领号，记下按什么条件查的
 *   const data = await fetchXxx(cond);
 *   if (!gate.accept(t, currentCondRef.current)) return; // 条件已经换了 / 有更新的已经显示了 → 扔
 *   setList(data);
 * 条件按「同一个对象」比（React 的 state 每次 set 都是新对象），所以条件要用 state / ref 里那一份，别现拼。
 */
export interface QueryTicket<K> { readonly seq: number; readonly key: K }
export interface QueryGate<K> {
  /** 出发时领号 */
  begin(key: K): QueryTicket<K>;
  /** 成功回来时问一声能不能用；能用就记下「已经显示到这一号」 */
  accept(ticket: QueryTicket<K>, currentKey: K): boolean;
  /** 失败回来时问一声：比它新的结果是不是已经显示了？是的话它的报错也不用说了（Codex 第 3 轮） */
  superseded(ticket: QueryTicket<K>): boolean;
  /**
   * 现在显示的，是不是「不比这一次请求旧」—— 还是同一个条件，而且它自己或者比它后发的成功结果已经显示了（Codex 第 7 轮）。
   * 用来回答「我要的刷新到底刷到没有」：后发的悄悄重拉抢先把新数据拉回来了，这一次自己被扔掉，也算刷到了。
   */
  covered(ticket: QueryTicket<K>, currentKey: K): boolean;
}

export function createQueryGate<K>(): QueryGate<K> {
  let seq = 0;
  let applied = 0;
  return {
    begin: (key) => ({ seq: ++seq, key }),
    accept: (ticket, currentKey) => {
      if (ticket.seq <= applied || !Object.is(ticket.key, currentKey)) return false;
      applied = ticket.seq;
      return true;
    },
    superseded: (ticket) => ticket.seq <= applied,
    covered: (ticket, currentKey) => Object.is(ticket.key, currentKey) && ticket.seq <= applied,
  };
}
