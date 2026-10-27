import { config } from "./config.js";
import { log } from "./logger.js";

const enabled = Boolean(
  config.notify.telegramToken && config.notify.telegramChatId,
);
let queue = Promise.resolve();

export function telegramEnabled() {
  return enabled;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Send Telegram HTML messages sequentially; log failures without throwing. */
export function notify(html) {
  if (!enabled) {
    log.info(
      "notify",
      `(Telegram not configured) ${html.replace(/<[^>]+>/g, "")}`,
    );
    return;
  }
  queue = queue
    .then(async () => {
      const res = await fetch(
        `https://api.telegram.org/bot${config.notify.telegramToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: config.notify.telegramChatId,
            text: html,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        },
      );
      if (!res.ok) {
        const t = await res.text();
        log.warn("notify", `Telegram ${res.status}: ${t.slice(0, 200)}`);
      }
    })
    .catch((e) =>
      log.warn("notify", `Failed to send Telegram message: ${e.message}`),
    );
  return queue;
}

export function projectMessage({ plan, action, detail }) {
  const bsc = (h) => `https://bscscan.com/tx/${h}`;
  const lines = [];
  lines.push(action);
  lines.push(`Project: <b>${esc(plan.name)}</b>`);
  lines.push(`Contract: <code>${esc(plan.contract)}</code>`);
  if (plan.qty) lines.push(`Quantity: ${plan.qty}`);
  lines.push(
    `Cost: ${Number(plan.valueWei ?? 0n) / 1e18} BNB (${esc(plan.priceSource || "?")})`,
  );
  // The caller supplies detail (including controlled HTML); do not escape it here. Escape dynamic text where it is assembled.
  if (detail) lines.push(detail);
  return lines.join("\n");
}
