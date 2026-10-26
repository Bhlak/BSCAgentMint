/**
 * 一次性登录币安 Agentic Wallet（baw）：
 * 1. 请求扫码登录（--json 拿 qrCodeId / 二维码链接）
 * 2. 打开/打印二维码，用币安 App 扫码确认
 * 3. 轮询直到登录完成，随后展示 BSC 地址
 */
import { baw, deepFind, wallet } from "../src/baw.js";
import { log } from "../src/logger.js";
import { exec } from "node:child_process";

/** 用系统默认浏览器打开二维码链接（失败静默，只打印 URL） */
const openUrl = (u) =>
  new Promise((resolve) => {
    const cmd = process.platform === "win32" ? `start "" "${u}"` : process.platform === "darwin" ? `open "${u}"` : `xdg-open "${u}"`;
    exec(cmd, { shell: true }, () => resolve());
  });

const r = await baw(["auth", "signin"]);
log.info("signin", JSON.stringify(r).slice(0, 1200));

const qrCodeId = deepFind(r, "qrCodeId") || deepFind(r, "qr_code_id");
const qrUrl =
  deepFind(r, "urlForWeb") || deepFind(r, "qrCodeUrl") || deepFind(r, "qrUrl") || deepFind(r, "url") || deepFind(r, "qrCodeLink");

if (!qrCodeId) {
  console.log("\n未解析到 qrCodeId。请手动运行下面命令，在终端里直接扫码：\n  npx baw auth signin\n");
  process.exit(0);
}

console.log("\n======== 请用币安 App（Web3 钱包）扫码登录 ========");
if (qrUrl) {
  console.log(`二维码链接: ${qrUrl}`);
  await openUrl(qrUrl).catch(() => {});
}
console.log("（如在浏览器看到二维码，用币安 App 扫描即可）\n");

const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
  await new Promise((s) => setTimeout(s, 3000));
  try {
    const v = await baw(["auth", "verify", "--qrCodeId", qrCodeId], 30_000);
    const s = JSON.stringify(v);
    log.info("signin", s.slice(0, 500));
    const status = (deepFind(v, "status") || "").toUpperCase();
    if (status === "CONNECTED" || /connected|success|COMPLETE/i.test(s)) {
      console.log("\n✅ 登录完成！");
      try {
        const addr = await wallet.address();
        console.log(`BSC 地址: ${addr}`);
        const agentId = await wallet.agentId();
        if (agentId) console.log(`Agent ID: ${agentId}`);
      } catch {}
      console.log("现在可以启动服务: npm start");
      process.exit(0);
    }
  } catch (e) {
    // 校验接口在等待期可能报未完成，继续轮询
    log.info("signin", `等待扫码… (${e.message.slice(0, 120)})`);
  }
}
console.log("\n⏱ 5 分钟未完成扫码，退出。可重新运行 npm run signin");
process.exit(0);
