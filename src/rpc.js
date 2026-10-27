import { config } from "./config.js";
import { log } from "./logger.js";

let urlIndex = 0;

async function post(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json();
    if (json.error)
      throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(t);
  }
}

/** Try RPC endpoints in sequence, failing over when one fails; propagate contract reverts without retrying another endpoint. */
async function call(method, params) {
  let lastErr;
  for (let i = 0; i < config.rpc.urls.length; i++) {
    const url = config.rpc.urls[(urlIndex + i) % config.rpc.urls.length];
    try {
      const result = await post(
        url,
        { jsonrpc: "2.0", id: 1, method, params },
        config.rpc.timeoutMs,
      );
      urlIndex = (urlIndex + i) % config.rpc.urls.length;
      return result;
    } catch (e) {
      if (/revert/i.test(e.message)) throw e; // A contract logic revert will also occur on another endpoint.
      lastErr = e;
      log.warn("rpc", `${url} ${method} failed: ${e.message}`);
    }
  }
  throw lastErr || new Error("All RPC endpoints are unavailable");
}

export const rpc = {
  /** Discoverer's first mint transaction: retrieve authoritative value / calldata. */
  async getTx(hash) {
    const tx = await call("eth_getTransactionByHash", [hash]);
    if (!tx) return null;
    return {
      from: tx.from,
      to: tx.to,
      value: tx.value, // hex quantity
      input: tx.input,
      blockNumber: tx.blockNumber,
    };
  },
  async getCode(address) {
    return call("eth_getCode", [address, "latest"]);
  },
  /** Read-only contract call simulation (used to screen candidate calldata). */
  async ethCall({ to, from, data, value = "0x0" }) {
    return call("eth_call", [{ to, from, data, value }, "latest"]);
  },
};
