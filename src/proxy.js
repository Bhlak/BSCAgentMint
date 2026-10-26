import { HttpsProxyAgent } from "https-proxy-agent";
import "./config.js"; // 副作用：尽早加载 .env，保证 PROXY_URL 可用

/**
 * 代理地址解析顺序：.env 的 PROXY_URL > 系统环境变量。
 * 用户的普通终端往往没有代理环境变量（Clash 只设置 WinINET 层），
 * 所以 PROXY_URL 是主要来源。
 */
export function getProxyUrl() {
  return (
    process.env.PROXY_URL ||
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    ""
  );
}

let cachedAgent;

/** 供 ws 库使用的代理 agent（ws 不读环境变量，必须显式传） */
export function getWsProxyAgent() {
  const url = getProxyUrl();
  if (!url) return undefined;
  if (!cachedAgent) cachedAgent = new HttpsProxyAgent(url);
  return cachedAgent;
}

/**
 * 让全局 fetch 走代理（RPC / Telegram 出站）。
 * Node >= 24 且 NODE_USE_ENV_PROXY=1 时本来就生效，这里兜底其他环境。
 */
export async function initProxyForFetch() {
  const url = getProxyUrl();
  if (!url) return;
  process.env.NODE_USE_ENV_PROXY = "1";
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(url));
  } catch {
    // 没有 undici 就依赖 NODE_USE_ENV_PROXY，或直连
  }
}

/** 给 baw 子进程用的环境（显式带上代理，避免用户终端缺变量导致直连超时） */
export function childProxyEnv() {
  const url = getProxyUrl();
  if (!url) return {};
  return {
    NODE_USE_ENV_PROXY: "1",
    https_proxy: url,
    http_proxy: url,
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
  };
}
