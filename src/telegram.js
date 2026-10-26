import { config } from "./config.js";
import { log } from "./logger.js";

const enabled = Boolean(config.notify.telegramToken && config.notify.telegramChatId);
let queue = Promise.resolve();

export function telegramEnabled() {
  return enabled;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 顺序发送 Telegram 消息（HTML），失败只记日志 */
export function notify(html) {
  if (!enabled) {
    log.info("notify", `（未配置 Telegram）${html.replace(/<[^>]+>/g, "")}`);
    return;
  }
  queue = queue
    .then(async () => {
      const res = await fetch(`https://api.telegram.org/bot${config.notify.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.notify.telegramChatId,
          text: html,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        log.warn("notify", `Telegram ${res.status}: ${t.slice(0, 200)}`);
      }
    })
    .catch((e) => log.warn("notify", `Telegram 发送失败: ${e.message}`));
  return queue;
}

export function projectMessage({ plan, action, detail }) {
  const bsc = (h) => `https://bscscan.com/tx/${h}`;
  const lines = [];
  lines.push(action);
  lines.push(`项目: <b>${esc(plan.name)}</b>`);
  lines.push(`合约: <code>${esc(plan.contract)}</code>`);
  if (plan.qty) lines.push(`数量: ${plan.qty}`);
  lines.push(`花费: ${Number(plan.valueWei ?? 0n) / 1e18} BNB（${esc(plan.priceSource || "?")}）`);
  // detail 由调用方拼接（含受控 HTML），不做转义；动态文本在拼接处转义
  if (detail) lines.push(detail);
  return lines.join("\n");
}
