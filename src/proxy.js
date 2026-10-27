import { HttpsProxyAgent } from "https-proxy-agent";
import "./config.js"; // Side effect: load .env early so PROXY_URL is available.

/**
 * Proxy URL precedence: .env PROXY_URL > system environment variables.
 * A regular terminal may not have proxy environment variables (Clash may only configure the WinINET layer),
 * so PROXY_URL is the primary source.
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

/** Proxy agent for the ws library (ws does not read environment variables, so pass it explicitly). */
export function getWsProxyAgent() {
  const url = getProxyUrl();
  if (!url) return undefined;
  if (!cachedAgent) cachedAgent = new HttpsProxyAgent(url);
  return cachedAgent;
}

/**
 * Route global fetch through the proxy (outbound RPC / Telegram requests).
 * This is natively supported by Node >= 24 with NODE_USE_ENV_PROXY=1; this provides a fallback for other environments.
 */
export async function initProxyForFetch() {
  const url = getProxyUrl();
  if (!url) return;
  process.env.NODE_USE_ENV_PROXY = "1";
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(url));
  } catch {
    // If undici is unavailable, rely on NODE_USE_ENV_PROXY or connect directly.
  }
}

/** Environment variables for the baw child process (explicitly include the proxy to avoid direct-connection timeouts when the terminal lacks proxy variables). */
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
