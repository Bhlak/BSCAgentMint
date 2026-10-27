import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import path from "node:path";
import { log } from "./logger.js";
import { childProxyEnv } from "./proxy.js";

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("@binance/agentic-wallet/package.json");
const pkg = require(pkgPath);
const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin && pkg.bin.baw;
const CLI_ENTRY = path.join(path.dirname(pkgPath), binRel);

const execFileP = promisify(execFile);

function parseJsonLoose(stdout) {
  const s = stdout.trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1) return { raw: s };
  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch {
    return { raw: s };
  }
}

/** Extract the underlying error from failed baw --json output (for example, EXECUTION_REVERTED: xxx); this is more useful than the command echo. */
function extractBawError(stdout) {
  const j = parseJsonLoose(stdout || "");
  if (j && j.error) {
    const name = j.error.name || j.error.code || "";
    const msg =
      j.error.message || (j.error.data && JSON.stringify(j.error.data)) || "";
    return (name + ": " + msg).trim();
  }
  return null;
}

/** Run the baw CLI (automatically appending --json), return parsed JSON or {raw}, and explicitly inject proxy settings into the child process. */
export async function baw(args, timeoutMs = 120_000) {
  const { stdout, stderr } = await execFileP(
    process.execPath,
    [CLI_ENTRY, ...args, "--json"],
    {
      timeout: timeoutMs,
      env: { ...process.env, ...childProxyEnv() },
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  ).catch((e) => {
    const out = ((e.stdout || "") + " " + (e.stderr || "")).trim();
    const real = extractBawError(e.stdout || "");
    throw new Error(
      `baw ${args.join(" ")} failed: ${real || e.message} | ${out.slice(-300)}`,
    );
  });
  if (stderr && stderr.trim())
    log.warn("baw", `stderr: ${stderr.trim().slice(0, 300)}`);
  return parseJsonLoose(stdout);
}

/** Find a value by key in an arbitrarily nested structure. */
export function deepFind(obj, key) {
  if (obj == null || typeof obj !== "object") return undefined;
  if (!Array.isArray(obj) && Object.prototype.hasOwnProperty.call(obj, key))
    return obj[key];
  for (const v of Object.values(obj)) {
    const hit = deepFind(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const RE_ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Select the BSC (chain 56) address from the address command's all-chain output. */
export function pickBscAddress(node) {
  const isAddr = (s) => typeof s === "string" && RE_ADDR.test(s);
  const walk = (n) => {
    if (n == null || typeof n !== "object") return null;
    if (!Array.isArray(n)) {
      // Supported shapes: {binanceChainId:56, address:'0x..'} / {chain:'BSC', address:'0x..'} / {'56':'0x..'} / {BSC:'0x..'}
      const vals = Object.values(n);
      if (vals.some((v) => isAddr(v))) {
        const chainMark = JSON.stringify(n).match(
          /"(?:binanceChainId|chainId|chain|chainName|network)"\s*:\s*"?(56|BSC|bsc|BSC_MAINNET)"?/,
        );
        if (chainMark) {
          for (const v of vals) if (isAddr(v)) return v;
        }
        if (isAddr(n["56"])) return n["56"];
        if (isAddr(n.BSC)) return n.BSC;
      }
    }
    for (const v of Object.values(n)) {
      const hit = walk(v);
      if (hit) return hit;
    }
    return null;
  };
  return walk(node);
}

export const wallet = {
  async status() {
    const r = await baw(["wallet", "status"]);
    return deepFind(r, "status") || "UNKNOWN";
  },
  /** Agentic Wallet address on BSC (the address command returns all chains, so select the BSC entry). */
  async address() {
    const r = await baw(["wallet", "address"]);
    const found = pickBscAddress(r);
    if (!found)
      log.warn(
        "baw",
        `Could not identify a BSC address in the address command output: ${JSON.stringify(r).slice(0, 400)}`,
      );
    return found;
  },
  /** Wallet BNB balance; return null if unavailable without blocking the workflow. */
  async bnbBalance() {
    try {
      const r = await baw(["wallet", "balance", "--binanceChainId", "56"]);
      const str = JSON.stringify(r);
      const m = str.match(
        /\{[^{}]*"symbol"\s*:\s*"BNB"[^{}]*\}|\{[^{}]*"BNB"[^{}]*\}/,
      );
      if (m) {
        const bm =
          m[0].match(/"balance"\s*:\s*"?([0-9.]+)/) ||
          m[0].match(/"amount"\s*:\s*"?([0-9.]+)/);
        if (bm) return Number(bm[1]);
      }
      return null;
    } catch {
      return null;
    }
  },
  async agentId() {
    try {
      const r = await baw(["wallet", "agent-id"]);
      return deepFind(r, "agentId") || deepFind(r, "agentID") || null;
    } catch {
      return null;
    }
  },
  async contractCallPreview({ from, to, valueWei, inputData }) {
    const r = await baw([
      "contract-call",
      "preview",
      "--binanceChainId",
      "56",
      "--from",
      from,
      "--to",
      to,
      "--value",
      String(valueWei),
      "--inputData",
      inputData,
    ]);
    const requestId = deepFind(r, "requestId");
    if (!requestId)
      throw new Error(
        `Preview did not return a requestId: ${JSON.stringify(r).slice(0, 800)}`,
      );
    return { requestId, raw: r };
  },
  async contractCallExecute(requestId) {
    const r = await baw(
      ["contract-call", "execute", "--requestId", requestId],
      180_000,
    );
    return {
      txHash: deepFind(r, "txHash") || deepFind(r, "transactionHash") || null,
      status: deepFind(r, "status") || null,
      raw: r,
    };
  },
};
