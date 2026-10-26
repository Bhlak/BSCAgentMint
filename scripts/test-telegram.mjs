import { config } from "../src/config.js";
import { notify, telegramEnabled } from "../src/telegram.js";
import { initProxyForFetch } from "../src/proxy.js";

await initProxyForFetch();

if (!telegramEnabled()) {
  console.log("未配置 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID（.env）");
  process.exit(0);
}

notify("✅ BSCAgentMint Telegram 通知测试");
setTimeout(() => process.exit(0), 5000);
