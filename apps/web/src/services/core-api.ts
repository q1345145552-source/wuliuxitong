import { clearAuthSession, clearClientOrderCaches, getOptionalSession } from "../auth/auth-session";

/**
 * 统一去除 URL 末尾斜杠，避免拼接路径时出现双斜杠。
 */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

/**
 * 计算前端请求 API 的基础地址。
 * 浏览器端固定走相对路径（Next.js rewrites 代理），服务端渲染时才用环境变量。
 * 2026-08-31：删掉了「Render 域名自动推断」那段老逻辑（inferRenderApiUrlFromWindow /
 * isLoopbackApiUrl）—— 上面那行 `typeof window` 早把浏览器端截走了，
 * 推断函数在服务端永远返回 null，整段一次都执行不到，留着只会误导人。
 */
export function apiBaseUrl(): string {
  // 浏览器端用相对路径，走 Next.js rewrites 代理到 API
  if (typeof window !== "undefined") return "";
  const configured = (process.env.NEXT_PUBLIC_API_BASE_URL ?? process.env.VITE_API_BASE_URL ?? "http://localhost:3001").trim();
  return trimTrailingSlash(configured);
}

/**
 * 生成需要鉴权的请求头。
 */
export function authHeaders(): Record<string, string> {
  const session = getOptionalSession();
  if (!session || !session.token) {
    return {};
  }
  return {
    Authorization: `Bearer ${session.token}`,
  };
}

// 只关联本次请求实际携带的令牌；元数据不写磁盘、不输出，也不改变 Response。
const responseTokens = new WeakMap<Response, string | null>();

/**
 * 一次请求最多能发多大（2026-09-29 老板选 A）。
 * 线上是 nginx → Next 转发 → 接口，**Next 转发那一跳的请求体上限是 10 MiB**（见记忆 upload-size-ceiling-is-nextjs-10mib）。
 * 超过的请求不会被当场拒绝，而是卡满 30 秒再回英文「Internal Server Error」/「服务器繁忙」/「请求超时」，重试多少次都没用
 * （测试库实测：9MB 的图走转发 30.4 秒后 500）。图片是 base64 放在 JSON 里发的，原图约 7.7MB 就到顶了。
 * 所以在发出去之前就量一下，超了当场给一句看得懂的中文。
 * 取 1040 万字节：隔离环境实测 10,400,000 字节 0.1 秒就到了接口、10,490,000 字节卡 30 秒后 500（2026-09-29）；
 * 第一版取的 980 万比天花板紧了 0.65MB，会把本来传得上去的多图请求（整柜询价一次带好几张图）挡掉（dsh 复核指出）。
 */
export const REQUEST_BODY_MAX_BYTES = 10_400_000;

/** 请求体（UTF-8）有多少字节。短的直接按字数估（base64 / 英文一字一字节），长的才精确量，省得每个请求都编码一遍 */
function requestBodyBytes(body: string): number {
  if (body.length < 3_000_000) return body.length;
  return new Blob([body]).size;
}

/**
 * 超了就给的中文提示（导出给测试用）。
 * 不只图片：整柜询价的「认证文件」可以是 PDF / 压缩包，所以写「图片或文件」，别让人对着一个 PDF 去「压缩图片」。
 * 大小按 base64 折回原文件大小（× 3/4），跟客户在电脑上看到的文件大小对得上。
 */
export function requestTooLargeMessage(bytes: number): string {
  const mb = ((bytes * 3) / 4 / 1024 / 1024).toFixed(1);
  return `要上传的图片或文件太大了（这次一共约 ${mb} MB），传不上去。请压缩一下或者少选几个，一次一共 6MB 以内再传。`;
}

/** 原样透传 fetch，只为后续解析记录请求身份。旧响应不能清除后来建立的新会话。 */
export async function fetchWithSession(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // 请求体太大：不发，当场报中文（原因见 REQUEST_BODY_MAX_BYTES）。项目里所有请求都走这里，一处管全部上传入口。
  if (typeof init?.body === "string") {
    const bytes = requestBodyBytes(init.body);
    if (bytes > REQUEST_BODY_MAX_BYTES) throw new Error(requestTooLargeMessage(bytes));
  }
  const requestHeaders = new Headers(init?.headers ?? (
    typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined
  ));
  const requestToken = requestHeaders.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
  // 使用成员调用，保持浏览器 fetch 的 globalThis binding；不新增请求头、重试或超时。
  const response = await globalThis.fetch(input, init);
  responseTokens.set(response, requestToken);
  return response;
}

/** 读令牌自带的到期时间（秒）。读不出来返回 null。⚠️ 不返回令牌内容。 */
function readTokenExp(token: string | undefined): number | null {
  if (!token) return null;
  try {
    const body = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof body?.exp === "number" ? body.exp : null;
  } catch {
    return null;
  }
}

function goToLogin() {
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login?expired=1";
  }
}

/**
 * 连续多少次「令牌看着没过期、后端却不认」就还是把人踢去重新登录。
 * 保险丝：万一后端换了签名密钥，所有人的令牌都会变成「没过期但不被认」，
 * 这时候如果永远不跳登录页，用户就只能一直看报错、连重新登录的入口都摸不到。
 */
const MAX_UNEXPLAINED_401 = 3;
let unexplained401Count = 0;
let unexplained401Token: string | null | undefined;

/**
 * 统一解析后端响应并在失败时抛出可读错误。
 *
 * 401 的处理（2026-08-07 改）：
 * 原来只要任何一个后台请求返回 401，就立刻清登录、跳登录页 ——
 * 员工正在填的东西全没了。而且实际发生过两次「令牌明明是好的却被踢」，
 * 查不出原因（详见下面的 console 日志）。
 * 现在只有**本地令牌确实已经过期**（或压根没登录）才跳登录页；
 * 令牌看着还有效的，只报错、不踢人，让用户能把手上的活保住。
 */
export async function parseApiResponse<T>(response: Response, sentToken?: string | null): Promise<T> {
  // undefined 表示未知来源；null 则明确表示请求发出时没有 Bearer 令牌。
  const requestToken = sentToken !== undefined ? sentToken : responseTokens.get(response);
  const session = typeof window !== "undefined" ? getOptionalSession() : null;
  const currentToken = session?.token ?? null;
  const belongsToCurrentSession = requestToken !== undefined && requestToken === currentToken;

  if (response.status === 401) {
    // 密码校验失败只反馈给登录表单，不退出其它仍在工作的标签。
    if (response.url.includes("/auth/login")) {
      throw new Error("账号或密码不对，请重新输入");
    }
    if (!belongsToCurrentSession) {
      // 不知道请求身份，或请求期间已经换号/重新登录：只拒绝这份响应，不计入新会话的 401。
      // ⚠️ requestToken === undefined 说明这份 Response 没经过 fetchWithSession（裸 fetch）——
      //    这条路永远不会跳登录页。仓库里所有调用点都用 `fetchWithSession as fetch`，
      //    scripts/test-session-api.ts 有源码扫描兜底；这里再吼一声，方便开发时当场发现。
      if (requestToken === undefined && typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
        console.warn("[接口返回 401] 这份响应没经过 fetchWithSession，无法判断令牌归属，不会自动跳登录页", { 接口: response.url });
      }
      throw new Error("这次请求的登录信息已变化或未通过校验，请重新操作");
    }
    if (unexplained401Token !== requestToken) {
      unexplained401Token = requestToken;
      unexplained401Count = 0;
    }
    const exp = readTokenExp(session?.token);
    const nowSec = Math.floor(Date.now() / 1000);
    const reallyExpired = !session?.token || exp == null || nowSec >= exp;

    if (typeof window !== "undefined") {
      console.warn("[接口返回 401]", {
        接口: response.url,
        本地有没有登录信息: !!session,
        角色: session?.role ?? "无",
        令牌到期: exp == null ? "读不出来" : `${new Date(exp * 1000).toLocaleString()}（${nowSec >= exp ? "已过期" : `还剩 ${Math.round((exp - nowSec) / 60)} 分钟`}）`,
        处理: reallyExpired ? "当前请求会话已过期，清理后重新登录" : `同一会话第 ${unexplained401Count + 1} 次校验失败（满 ${MAX_UNEXPLAINED_401} 次才退出）`,
      });
    }
    const rejectCurrentSession = () => {
      // 登录页不再负责全局退出；在最终失败点再次比对，明确清理仍对应本次请求的会话。
      if (typeof window === "undefined" || (getOptionalSession()?.token ?? null) !== requestToken) return;
      clearAuthSession();
      clearClientOrderCaches();
      goToLogin();
    };
    if (reallyExpired) {
      unexplained401Count = 0;
      rejectCurrentSession();
      throw new Error("登录已过期，请重新登录");
    }
    unexplained401Count += 1;
    if (unexplained401Count >= MAX_UNEXPLAINED_401) {
      unexplained401Count = 0;
      rejectCurrentSession();
      throw new Error("登录状态异常，请重新登录");
    }
    throw new Error("这一步没能通过登录校验，请重试一次；反复出现请重新登录（你填的内容还在）");
  }
  // 仅当前会话自己的响应能重置其计数；旧会话迟到的成功响应不干扰新会话。
  if (belongsToCurrentSession) {
    unexplained401Token = requestToken;
    unexplained401Count = 0;
  }
  const text = await response.text();
  let payload: { code?: string; message?: string; data?: T } | null = null;
  try {
    payload = text ? (JSON.parse(text) as { code?: string; message?: string; data?: T }) : null;
  } catch {
    if (!response.ok) throw new Error(`请求失败 ${response.status}${text ? `: ${text.slice(0, 150)}` : ""}`);
    throw new Error("invalid response");
  }
  if (!response.ok || payload?.code !== "OK") {
    throw new Error(payload?.message ?? "request failed");
  }
  return payload.data as T;
}

/**
 * 统一 API 请求：fetch + 超时 + 429重试 + parseApiResponse + 错误兜底。
 * 所有 API 调用必须使用此包装，禁止裸调 fetch。
 */
export async function apiRequest<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  let lastError: Error | null = null;
  // 429 限流自动重试最多 2 次，间隔 2s / 4s
  for (let attempt = 0; attempt < 3; attempt++) {
    // 【审查问题 9】超时控制器改成每次请求各自一个：
    // 原来 3 次重试共用一个 30 秒计时器，等待的 2s+4s 也算在里面，
    // 最后一次实际只剩不到 24 秒；而且一旦 abort 过，signal 就报废了。
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000); // 单次请求 30 秒超时
    try {
      const response = await fetchWithSession(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...authHeaders(),
          ...(options.headers as Record<string, string> || {}),
        },
      });

      // 429 限流 → 等待后重试
      if (response.status === 429 && attempt < 2) {
        clearTimeout(timeout);
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }

      // 【审查问题 4】5xx 只提示、不重试。
      // 原来这里 throw 会被下面的 catch 接住再 continue，等于服务器已经扛不住了
      // 前端还给它发 3 倍请求。直接跳出循环。
      if (response.status >= 500) {
        lastError = new Error("服务器繁忙，请稍后重试");
        break;
      }

      return await parseApiResponse<T>(response);
    } catch (e: any) {
      lastError = e instanceof Error ? e : new Error(String(e));
      // 超时
      if (e?.name === "AbortError") {
        lastError = new Error("请求超时，请检查网络后重试");
        break;
      }
      // 网络断开
      if (e instanceof TypeError && (e.message.includes("fetch") || e.message.includes("network"))) {
        lastError = new Error("网络连接异常，请检查网络后重试");
        break;
      }
      // 其余错误（含后端返回的业务错误）不重试，直接抛给调用方
      break;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("请求失败");
}
