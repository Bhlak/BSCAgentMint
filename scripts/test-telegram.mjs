import { config } from "../src/config.js";
import { notify, telegramEnabled } from "../src/telegram.js";
import { initProxyForFetch } from "../src/proxy.js";

await initProxyForFetch();

if (!telegramEnabled()) {
  console.log(
    "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not configured (.env)",
  );
  process.exit(0);
}

notify("✅ BSCAgentMint Telegram notification test");
setTimeout(() => process.exit(0), 5000);
