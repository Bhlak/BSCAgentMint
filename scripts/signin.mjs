/**
 * Sign in to Binance Agentic Wallet (baw) once:
 * 1. Request QR sign-in (--json returns qrCodeId / QR code URL)
 * 2. Open or print the QR code and scan it with the Binance app to confirm
 * 3. Poll until sign-in completes, then display the BSC address
 */
import { baw, deepFind, wallet } from "../src/baw.js";
import { log } from "../src/logger.js";
import { exec } from "node:child_process";

/** Open the QR code URL in the system's default browser (fail silently and only print the URL). */
const openUrl = (u) =>
  new Promise((resolve) => {
    const cmd =
      process.platform === "win32"
        ? `start "" "${u}"`
        : process.platform === "darwin"
          ? `open "${u}"`
          : `xdg-open "${u}"`;
    exec(cmd, { shell: true }, () => resolve());
  });

const r = await baw(["auth", "signin"]);
log.info("signin", JSON.stringify(r).slice(0, 1200));

const qrCodeId = deepFind(r, "qrCodeId") || deepFind(r, "qr_code_id");
const qrUrl =
  deepFind(r, "urlForWeb") ||
  deepFind(r, "qrCodeUrl") ||
  deepFind(r, "qrUrl") ||
  deepFind(r, "url") ||
  deepFind(r, "qrCodeLink");

if (!qrCodeId) {
  console.log(
    "\nCould not find qrCodeId. Run the following command and scan the QR code in the terminal:\n  npx baw auth signin\n",
  );
  process.exit(0);
}

console.log(
  "\n======== Scan to sign in with the Binance app (Web3 Wallet) ========",
);
if (qrUrl) {
  console.log(`QR code URL: ${qrUrl}`);
  await openUrl(qrUrl).catch(() => {});
}
console.log(
  "(If a QR code appears in your browser, scan it with the Binance app.)\n",
);

const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
  await new Promise((s) => setTimeout(s, 3000));
  try {
    const v = await baw(["auth", "verify", "--qrCodeId", qrCodeId], 30_000);
    const s = JSON.stringify(v);
    log.info("signin", s.slice(0, 500));
    const status = (deepFind(v, "status") || "").toUpperCase();
    if (status === "CONNECTED" || /connected|success|COMPLETE/i.test(s)) {
      console.log("\n✅ Sign-in complete!");
      try {
        const addr = await wallet.address();
        console.log(`BSC address: ${addr}`);
        const agentId = await wallet.agentId();
        if (agentId) console.log(`Agent ID: ${agentId}`);
      } catch {}
      console.log("You can now start the service: npm start");
      process.exit(0);
    }
  } catch (e) {
    // The verification endpoint may report incomplete while waiting; continue polling.
    log.info("signin", `Waiting for QR scan… (${e.message.slice(0, 120)})`);
  }
}
console.log(
  "\n⏱ QR sign-in was not completed within 5 minutes. Exiting; run npm run signin to try again.",
);
process.exit(0);
