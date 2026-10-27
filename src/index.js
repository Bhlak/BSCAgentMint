import { config } from "./config.js";
import { log } from "./logger.js";
import { initProxyForFetch } from "./proxy.js";
import { store } from "./state.js";
import { MintgoStream } from "./stream.js";
import { handleEvent, setWalletState } from "./minter.js";
import { notify, telegramEnabled } from "./telegram.js";
import { wallet } from "./baw.js";

const maskKey = (k) =>
  k.length > 24 ? k.slice(0, 12) + "…" + k.slice(-6) : "…";

async function main() {
  await initProxyForFetch();

  log.info(
    "boot",
    `BSCAgentMint started AUTO_MINT=${config.autoMint} DRY_RUN=${config.dryRun} MAX_VALUE_BNB=${config.mint.maxValueBnb} daily limit=${config.mint.maxPerDay}`,
  );
  log.info(
    "boot",
    `MintGo key: ${maskKey(config.mintgo.apiKey)} | Telegram: ${telegramEnabled() ? "configured" : "not configured (logging only)"}`,
  );

  // Check baw sign-in status (failure does not block startup; minter has a fallback).
  let connected = false;
  let address = null;
  try {
    const status = await wallet.status();
    connected = String(status).toUpperCase() === "CONNECTED";
    log.info("boot", `baw wallet status: ${status}`);
    if (connected) {
      address = await wallet.address();
      const agentId = await wallet.agentId();
      log.info(
        "boot",
        `BSC address: ${address} | Agent ID: ${agentId || "(not found)"}`,
      );
      notify(
        `🤖 <b>BSCAgentMint started</b>\nWallet: <code>${address || "?"}</code>\nAgent ID: ${agentId || "-"}\nMode: ${config.dryRun ? "DRY-RUN" : config.autoMint ? "Auto mint" : "Notifications only"}`,
      );
    } else {
      log.warn(
        "boot",
        "baw is not signed in. Run npm run signin to sign in by scanning the QR code; notifications only until sign-in.",
      );
      notify(
        "🤖 <b>BSCAgentMint started (baw not signed in)</b>\nRun <code>npm run signin</code> and scan the QR code to sign in to Binance Agentic Wallet before automatic minting can begin.",
      );
    }
  } catch (e) {
    log.warn(
      "boot",
      `Failed to check baw status (continuing startup): ${e.message}`,
    );
  }
  setWalletState({ connected, address });

  // Process events serially to avoid concurrent transactions.
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    chain = chain.then(fn).catch((e) => log.error("queue", e.message));
  };

  const stream = new MintgoStream({
    getCursor: () => store.cursor,
    onCursor: (n) => store.setCursor(n),
  });

  stream.on("ready", (info) => {
    const expiresAt = info.expiresAt || 0;
    if (
      expiresAt &&
      expiresAt - Date.now() < 48 * 3600_000 &&
      store.shouldWarnKeyExpiry()
    ) {
      const t = new Date(expiresAt).toISOString();
      notify(
        `⏰ <b>MintGo API key expiring soon</b> (${t}). Reset it at mintgo.fun and update MINTGO_API_KEY in .env.`,
      );
    }
  });

  stream.on("event", (event) => {
    enqueue(() => handleEvent(event));
  });

  const shutdown = () => {
    log.info("boot", "Shutting down");
    stream.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  stream.start();
}

main().catch((e) => {
  log.error("boot", e.stack || e.message);
  process.exit(1);
});
