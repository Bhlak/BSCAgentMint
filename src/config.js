import dotenv from "dotenv";

dotenv.config();

const bool = (v, d) =>
  v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
const num = (v, d) => {
  const n = Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) ? d : n;
};

export const config = {
  mintgo: {
    streamUrl: process.env.MINTGO_STREAM_URL || "wss://mintgo.fun/api/bsc-projects/stream",
    apiKey: process.env.MINTGO_API_KEY || "",
  },
  autoMint: bool(process.env.AUTO_MINT, true),
  dryRun: bool(process.env.DRY_RUN, false),
  mint: {
    maxValueBnb: num(process.env.MAX_VALUE_BNB, 0),
    allowUnknownPrice: bool(process.env.MINT_UNKNOWN_PRICE, false),
    maxPerDay: Math.max(0, Math.floor(num(process.env.MAX_MINTS_PER_DAY, 20))),
    bnbReserve: num(process.env.BNB_RESERVE, 0.003),
    quantityMode: process.env.MINT_QUANTITY_MODE === "one" ? "one" : "replicate",
  },
  notify: {
    nonFree: bool(process.env.NOTIFY_NON_FREE, true),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  },
  rpc: {
    urls: (process.env.BSC_RPC_URLS ||
      "https://bsc-dataseed.binance.org,https://bsc-dataseed1.defibit.io")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    timeoutMs: 10_000,
  },
  chainId: 56, // BSC
};

if (!config.mintgo.apiKey) {
  console.error("[config] 缺少 MINTGO_API_KEY（.env）");
  process.exit(1);
}
