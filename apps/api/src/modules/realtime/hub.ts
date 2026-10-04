import type { UserRole } from "../../../../../packages/shared-types/role";
import { AGENT_TOPICS, CLIENT_TOPICS, type RealtimeTopic } from "./topics";

/**
 * 实时推送的「总机」（2026-10-05）：谁连着、谁该收到哪条变化。
 *
 * ⚠️ 只在这一个 API 进程的内存里。线上就一个 api 容器，够用；
 * 哪天开第二个容器，这里要换成 Redis 发布订阅，不然另一个容器上的人收不到。
 */

export interface RealtimeActor {
  userId: string;
  role: UserRole;
  /** 客户：归哪个代理（湘泰自己的客户为 null）；代理：自己的代理 id；员工 / 管理员：null */
  agentId: string | null;
}

export interface ChangeEvent {
  companyId: string;
  topic: RealtimeTopic;
  actor: RealtimeActor;
  /** 明确只跟这几个客户有关（目前只有员工回客服消息时知道是谁）；不填 = 不知道是谁 */
  clientIds?: string[];
}

export interface RealtimeConnection {
  readonly id: number;
  readonly userId: string;
  readonly companyId: string;
  readonly role: UserRole;
  /** 每分钟复查登录状态时会更新（客户改归属、代理停用当场生效） */
  agentId: string | null;
  /** 把一批分类写给这条连接 */
  write(topics: RealtimeTopic[]): void;
  /** 断开（挤掉、登录失效、停机） */
  close(reason: string): void;
}

/**
 * 这条变化该不该推给这条连接。
 *
 * - 别的公司：一律不推。
 * - 员工 / 管理员：本公司的全都推（他们本来就看全公司）。
 * - 客户：只推客户页面用得到的分类；知道是哪个客户的只推给那个客户；
 *   客户自己做的只推给自己；员工做的不知道影响谁，就推给本公司全部客户 ——
 *   推的只是「某一类变了」，客户页面重拉的还是自己那份，不会多看到别人的东西。
 * - 代理：只推代理页面用得到的分类；只认员工做的、自己做的、自己名下客户做的。
 */
export function shouldDeliver(conn: Pick<RealtimeConnection, "userId" | "companyId" | "role" | "agentId">, ev: ChangeEvent): boolean {
  if (conn.companyId !== ev.companyId) return false;
  if (conn.role === "admin" || conn.role === "staff") return true;
  const actorIsStaff = ev.actor.role === "admin" || ev.actor.role === "staff";

  if (conn.role === "client") {
    if (!CLIENT_TOPICS.has(ev.topic)) return false;
    if (ev.clientIds) return ev.clientIds.includes(conn.userId);
    if (ev.actor.role === "client") return ev.actor.userId === conn.userId;
    if (ev.actor.role === "agent") return ev.actor.agentId !== null && ev.actor.agentId === conn.agentId;
    return actorIsStaff;
  }

  if (conn.role === "agent") {
    if (!AGENT_TOPICS.has(ev.topic)) return false;
    if (ev.clientIds) return false;
    if (actorIsStaff) return true;
    return ev.actor.agentId !== null && ev.actor.agentId === conn.agentId;
  }

  return false;
}

/** 被挤掉时断开原因的开头（前端认这个：停下等人点回来，别马上重连） */
export const EVICTED_PREFIX = "busy:";
/** 一个账号最多同时开几条（多个标签页 / 手机 + 电脑）。超了挤掉最早那条 */
export const MAX_CONNECTIONS_PER_USER = 8;
/** 整个进程最多多少条，防有人刷连接把内存吃光 */
export const MAX_CONNECTIONS_TOTAL = 3000;
/**
 * 同一条连接攒多久发一次。员工批量操作（一次改几十票）会连着来几十条变化，
 * 攒 150 毫秒合成一条，页面只重拉一次；人感觉不到这点延迟。
 */
export const COALESCE_MS = 150;

interface Slot {
  conn: RealtimeConnection;
  pending: Set<RealtimeTopic>;
  timer: ReturnType<typeof setTimeout> | null;
}

export class RealtimeHub {
  private slots = new Map<number, Slot>();
  private nextId = 1;

  constructor(private readonly coalesceMs = COALESCE_MS) {}

  /** 给新连接发号（连接对象要先有 id 才能造出来） */
  allocateId(): number {
    return this.nextId++;
  }

  get size(): number {
    return this.slots.size;
  }

  add(conn: RealtimeConnection): void {
    /* 同一个人连太多：挤掉最早的（Map 按插入顺序遍历，先遇到的就是最早的）。
       原因以「busy:」开头：前端收到就停下、等那个页面被人点回来才重连 ——
       不能马上重连，不然它回来又挤掉别人，几个页面轮着每秒互挤（dsh 2026-10-05 实测复现过）。 */
    const mine = [...this.slots.values()].filter((s) => s.conn.userId === conn.userId);
    for (const s of mine.slice(0, Math.max(0, mine.length - MAX_CONNECTIONS_PER_USER + 1))) {
      s.conn.close(`${EVICTED_PREFIX}同一账号打开的页面太多，最早的那个已断开实时更新`);
    }
    if (this.slots.size >= MAX_CONNECTIONS_TOTAL) {
      const oldest = this.slots.values().next().value as Slot | undefined;
      oldest?.conn.close(`${EVICTED_PREFIX}服务器实时连接已满`);
    }
    this.slots.set(conn.id, { conn, pending: new Set(), timer: null });
  }

  remove(id: number): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    if (slot.timer) clearTimeout(slot.timer);
    this.slots.delete(id);
  }

  publish(ev: ChangeEvent): void {
    for (const slot of this.slots.values()) {
      if (!shouldDeliver(slot.conn, ev)) continue;
      slot.pending.add(ev.topic);
      if (slot.timer) continue;
      slot.timer = setTimeout(() => {
        slot.timer = null;
        if (!this.slots.has(slot.conn.id) || slot.pending.size === 0) return;
        const topics = [...slot.pending];
        slot.pending.clear();
        slot.conn.write(topics);
      }, this.coalesceMs);
    }
  }

  /** 停机时把所有人断开（他们会自己重连到新容器） */
  closeAll(reason: string): void {
    for (const slot of [...this.slots.values()]) slot.conn.close(reason);
  }
}

/** 进程里唯一那个总机 */
export const realtimeHub = new RealtimeHub();
