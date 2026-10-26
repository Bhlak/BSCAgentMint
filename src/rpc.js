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
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(t);
  }
}

/** 轮询 RPC 列表，单个节点失败自动切下一个；业务性 revert 直接抛出不再切换 */
async function call(method, params) {
  let lastErr;
  for (let i = 0; i < config.rpc.urls.length; i++) {
    const url = config.rpc.urls[(urlIndex + i) % config.rpc.urls.length];
    try {
      const result = await post(url, { jsonrpc: "2.0", id: 1, method, params }, config.rpc.timeoutMs);
      urlIndex = (urlIndex + i) % config.rpc.urls.length;
      return result;
    } catch (e) {
      if (/revert/i.test(e.message)) throw e; // 合约逻辑性回滚，换节点也一样
      lastErr = e;
      log.warn("rpc", `${url} ${method} 失败: ${e.message}`);
    }
  }
  throw lastErr || new Error("所有 RPC 均不可用");
}

export const rpc = {
  /** 发现者首笔 mint 交易：拿权威 value / calldata */
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
  /** 只读模拟合约调用（用于候选 calldata 筛选） */
  async ethCall({ to, from, data, value = "0x0" }) {
    return call("eth_call", [{ to, from, data, value }, "latest"]);
  },
};
