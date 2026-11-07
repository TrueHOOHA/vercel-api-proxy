/**
 * Edge Function 版反向代理（增强模式）
 *
 *   /api/proxy/https/目标域名/路径  ->  https://目标域名/路径
 *
 * 相比 vercel.json 的 rewrite 直转路径（/https/目标/路径），这里多两个能力：
 *
 *   ① 跟随 3xx 跳转：目标站返回 301/302 时，响应的 Location 头会被重写回
 *      代理格式（跨域跳转也重新包装），链路始终走代理不断链。
 *      例：github.com releases -> objects.githubusercontent.com 的 302。
 *
 *   ③ CORS：响应自动带 Access-Control-Allow-Origin: *，并直接应答 OPTIONS
 *      预检，浏览器网页里的 JS 可以直接 fetch 本代理。
 *
 * 大文件下载、普通服务器端 API 调用请走 /https/... 直转路径（无函数时长
 * 限制、保留 Content-Length）。本路径会把请求体整体读入内存，仅适合普通请求。
 */

export const config = { runtime: 'edge' };

const PREFIX = '/api/proxy';

/** 不转发给目标站的请求头（逐跳头 + Vercel 注入头） */
const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Vercel 注入的、会让目标站困惑的头
  'x-forwarded-host',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
  'x-vercel-id',
  'x-vercel-ip',
  'x-vercel-forwarded-for',
  'cdn-loop',
]);

/**
 * 不透传给客户端的响应头：响应体被 fetch 解压、重新分块传输后，
 * 这些头与实际内容不再对应（由平台重新生成）
 */
const SKIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
]);

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': '*',
};

const HOST_RE = /^(?=.{1,253}$)(?=[^\s]*[a-z0-9])[a-z0-9._-]+(:\d+)?$/i;

/**
 * 解析代理路径 /api/proxy/<scheme>/<host>/<path...>
 * 保留路径尾部的斜杠（部分站点对尾斜杠敏感）
 */
export function parseProxyPath(
  pathname: string,
): { scheme: string; host: string; basePath: string } | null {
  const rest = pathname.slice(PREFIX.length + 1); // 'https/a.com/v1/x/'
  const schemeEnd = rest.indexOf('/');
  if (schemeEnd === -1) return null;
  const scheme = rest.slice(0, schemeEnd).toLowerCase();
  const hostAndPath = rest.slice(schemeEnd + 1);
  const hostEnd = hostAndPath.indexOf('/');
  const host = hostEnd === -1 ? hostAndPath : hostAndPath.slice(0, hostEnd);
  const basePath = hostEnd === -1 ? '' : hostAndPath.slice(hostEnd + 1);
  if (!/^https?$/.test(scheme) || !HOST_RE.test(host)) return null;
  return { scheme, host, basePath };
}

/**
 * 把目标站返回的 Location 重写回代理格式。
 * 绝对地址 / 相对路径 / 协议相对路径（//host/x）都能处理。
 */
export function rewrapLocation(
  location: string,
  scheme: string,
  host: string,
  basePath: string,
): string {
  let resolved: URL;
  try {
    resolved = new URL(location, `${scheme}://${host}/${basePath}`);
  } catch {
    return location; // 解析不了就原样返回，交给浏览器处理
  }
  const proto = resolved.protocol.replace(':', '');
  return `${PREFIX}/${proto}/${resolved.host}${resolved.pathname}${resolved.search}${resolved.hash}`;
}

export default async function handler(request: Request): Promise<Response> {
  // CORS 预检直接应答，不触达目标站
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_HEADERS,
        'access-control-allow-methods': '*',
        'access-control-allow-headers':
          request.headers.get('access-control-request-headers') ?? '*',
        'access-control-max-age': '86400',
      },
    });
  }

  const url = new URL(request.url);
  const parsed = parseProxyPath(url.pathname);
  if (!parsed) {
    return json(400, {
      error: '路径格式不正确',
      usage: '/api/proxy/https/目标域名/路径（http 同理）',
    });
  }
  const { scheme, host, basePath } = parsed;
  const target = `${scheme}://${host}/${basePath}${url.search}`;

  // 转发请求头（去掉逐跳头和 Vercel 注入头，其余原样转发，含 Authorization/Cookie）
  const fwd = new Headers();
  request.headers.forEach((value, key) => {
    if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) fwd.set(key, value);
  });

  // 请求体读入内存：manual 模式失败重试时 body 可以复用
  let body: ArrayBuffer | undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.arrayBuffer();
  }

  const init: RequestInit = { method: request.method, headers: fwd, body };

  let upstream: Response;
  try {
    upstream = await fetchManualOrFollow(target, init);
  } catch (err) {
    return json(502, { error: '代理请求失败', target, detail: String(err) });
  }

  // 组装响应头
  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === 'set-cookie' || k === 'location' || SKIP_RESPONSE_HEADERS.has(k)) return;
    resHeaders.set(key, value);
  });

  // ① 3xx：重写 Location，让浏览器沿着代理继续跳
  const location = upstream.headers.get('location');
  if (location) {
    resHeaders.set('location', rewrapLocation(location, scheme, host, basePath));
  }

  // Set-Cookie 多值：forEach 可能会把多条合并，用 getSetCookie 保证逐条透传
  if (typeof upstream.headers.getSetCookie === 'function') {
    for (const cookie of upstream.headers.getSetCookie()) {
      resHeaders.append('set-cookie', cookie);
    }
  } else {
    const cookie = upstream.headers.get('set-cookie');
    if (cookie) resHeaders.append('set-cookie', cookie);
  }

  // ③ CORS
  for (const [k, v] of Object.entries(CORS_HEADERS)) resHeaders.set(k, v);

  const nullBody =
    request.method === 'HEAD' ||
    upstream.status === 204 ||
    upstream.status === 205 ||
    upstream.status === 304;

  return new Response(nullBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}

/**
 * 优先 redirect: 'manual' 拿到 3xx 自己重写 Location；
 * 个别运行时不支持 manual（返回 opaqueredirect 或抛错），退化为 follow。
 */
async function fetchManualOrFollow(target: string, init: RequestInit): Promise<Response> {
  try {
    const res = await fetch(target, { ...init, redirect: 'manual' });
    if (res.type !== 'opaqueredirect') return res;
  } catch {
    // 落到下面用 follow 重试
  }
  return fetch(target, { ...init, redirect: 'follow' });
}

function json(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}
