import { config } from "./config.js";
import { log } from "./logger.js";
import { store } from "./state.js";
import { rpc } from "./rpc.js";
import { buildMintPlan, findMintCandidate, bnbToWei } from "./classify.js";
import { wallet } from "./baw.js";
import { notify, projectMessage } from "./telegram.js";

let walletState = { connected: false, address: null, warnedAt: 0 };

export function setWalletState(s) {
  walletState = { ...walletState, ...s };
}

async function hasContractCode(address) {
  try {
    const code = await rpc.getCode(address);
    return !!code && code !== "0x";
  } catch {
    return true; // If RPC is unavailable, proceed to preview (Binance will simulate the call).
  }
}

/**
 * Process a project.new event: classify → safety gates → baw preview/execute → notify.
 * Calls are serialized by the queue in index.js, so concurrency is not a concern here.
 */
export async function handleEvent(event) {
  const eventId = event.eventId;
  if (!eventId || !event.contractAddress) {
    log.warn("minter", "Event is missing eventId/contractAddress; ignoring");
    return;
  }

  store.appendEvent(event);

  if (store.hasSeen(eventId)) {
    log.info("minter", `Duplicate event ${eventId}; skipping`);
    return;
  }
  store.markSeen(eventId);

  const prev = store.attemptOf(eventId);
  if (prev) {
    log.info(
      "minter",
      `Event ${eventId} was already processed (${prev.status}); skipping`,
    );
    return;
  }

  log.info(
    "minter",
    `New project: ${event.name || "?"} ${event.contractAddress} valueNative=${event.valueNative} confirmed=${event.priceConfirmed} fn=${event.functionName}`,
  );

  const plan = await buildMintPlan(event, walletState.address);
  log.info(
    "minter",
    `Classification kind=${plan.kind} value=${plan.valueWei}n source=${plan.priceSource} note=${plan.note}`,
  );

  // ---- Classification gates ----
  if (plan.kind === "unknown") {
    store.recordAttempt(eventId, plan.contract, "unknown-price", {
      reason: plan.note,
    });
    notify(
      projectMessage({
        plan,
        action:
          "❓ <b>New project with unknown price</b> (not minted automatically)",
      }),
    );
    return;
  }
  if (plan.kind === "forbidden") {
    store.recordAttempt(eventId, plan.contract, "forbidden", {
      reason: plan.note,
    });
    notify(
      projectMessage({
        plan,
        action: "🚫 <b>Suspicious project blocked</b>",
        detail: plan.note,
      }),
    );
    return;
  }
  if (plan.kind === "paid") {
    const maxWei = bnbToWei(config.mint.maxValueBnb);
    if (plan.valueWei > maxWei) {
      store.recordAttempt(eventId, plan.contract, "paid-skip", {
        reason: `Cost exceeds MAX_VALUE_BNB=${config.mint.maxValueBnb}`,
      });
      if (config.notify.nonFree) {
        notify(
          projectMessage({
            plan,
            action: "💰 <b>Paid project; not minted automatically</b>",
          }),
        );
      } else {
        log.info("minter", "Paid project; notification disabled");
      }
      return;
    }
    // Paid mints within the allowed limit may proceed.
  }

  if (!config.autoMint) {
    store.recordAttempt(eventId, plan.contract, "auto-off");
    notify(
      projectMessage({
        plan,
        action: "🔔 <b>New project (automatic minting is disabled)</b>",
      }),
    );
    return;
  }

  // ---- Pre-execution safety gates ----
  const allow = store.dailyAllowance(config.mint.maxPerDay);
  if (allow <= 0) {
    store.recordAttempt(eventId, plan.contract, "daily-cap");
    notify(
      projectMessage({
        plan,
        action: "⛔ <b>Daily mint limit reached; skipping this project</b>",
      }),
    );
    return;
  }

  if (!plan.inputData) {
    store.recordAttempt(eventId, plan.contract, "no-calldata", {
      reason: plan.note,
    });
    notify(
      projectMessage({
        plan,
        action:
          "⚠️ <b>Free project, but calldata could not be constructed; not minted</b>",
        detail: plan.note,
      }),
    );
    return;
  }

  if (!(await hasContractCode(plan.contract))) {
    store.recordAttempt(eventId, plan.contract, "no-code");
    notify(
      projectMessage({
        plan,
        action:
          "🚫 <b>Contract has no code (possibly a fake deployment); not minted</b>",
      }),
    );
    return;
  }

  if (!walletState.connected || !walletState.address) {
    // Lazy recheck: no restart is needed after QR sign-in; probe at most once every 10 minutes.
    if (Date.now() - (walletState.lastProbeAt || 0) > 10 * 60_000) {
      walletState.lastProbeAt = Date.now();
      try {
        const st = await wallet.status();
        if (String(st).toUpperCase() === "CONNECTED") {
          walletState.connected = true;
          walletState.address = await wallet.address();
          log.info(
            "minter",
            `baw sign-in detected; address=${walletState.address}`,
          );
        }
      } catch {}
    }
  }
  if (!walletState.connected || !walletState.address) {
    store.recordAttempt(eventId, plan.contract, "wallet-unconnected");
    const now = Date.now();
    if (now - walletState.warnedAt > 6 * 3600_000) {
      walletState.warnedAt = now;
      notify(
        projectMessage({
          plan,
          action: "🔐 <b>Mintable project found, but baw is not signed in</b>",
          detail:
            "Run npm run signin and scan the QR code to sign in before automatic minting can begin.",
        }),
      );
    }
    return;
  }

  const bal = await wallet.bnbBalance();
  if (bal != null) {
    const need = Number(plan.valueWei) / 1e18 + config.mint.bnbReserve;
    if (bal < need) {
      store.recordAttempt(eventId, plan.contract, "low-balance", {
        reason: `BNB balance ${bal} is below the required threshold`,
      });
      notify(
        projectMessage({
          plan,
          action:
            "⛽ <b>Insufficient BNB balance (below reserve); not minted</b>",
          detail: `Balance: ${bal} BNB`,
        }),
      );
      return;
    }
  }

  if (config.dryRun) {
    store.recordAttempt(eventId, plan.contract, "dry-run", {
      to: plan.contract,
      value: String(plan.valueWei),
      inputData: plan.inputData,
    });
    notify(
      projectMessage({
        plan,
        action:
          "🧪 <b>DRY RUN: automatic mint would be attempted (stopped before broadcast)</b>",
        detail: `to=${plan.contract} value=${plan.valueWei} data=${plan.inputData.slice(0, 20)}…`,
      }),
    );
    return;
  }

  // ---- Execute: baw preview (simulated by Binance) → execute; try candidate calldata once if preview is rejected ----
  const tryMint = async (inputData) => {
    log.info(
      "minter",
      `preview: to=${plan.contract} value=${plan.valueWei} data=${inputData.slice(0, 34)}…`,
    );
    const { requestId } = await wallet.contractCallPreview({
      from: walletState.address,
      to: plan.contract,
      valueWei: plan.valueWei,
      inputData,
    });
    log.info("minter", `Preview OK; requestId=${requestId}; executing`);
    return wallet.contractCallExecute(requestId);
  };

  try {
    let viaCandidate = false;
    let exec;
    try {
      exec = await tryMint(plan.inputData);
    } catch (firstErr) {
      // Binance rejected the simulation, possibly because the discoverer's calldata has specific parameters or state changed. Try a candidate signature that passed simulation.
      const alt = await findMintCandidate(event, walletState.address);
      if (alt && alt.toLowerCase() !== String(plan.inputData).toLowerCase()) {
        log.info(
          "minter",
          `Preview rejected (${String(firstErr.message).slice(0, 160)}); trying candidate calldata: ${alt.slice(0, 10)}…`,
        );
        exec = await tryMint(alt);
        viaCandidate = true;
      } else {
        throw firstErr;
      }
    }
    log.info(
      "minter",
      `Execution complete; status=${exec.status} tx=${exec.txHash}`,
    );
    store.recordAttempt(eventId, plan.contract, "minted", {
      txHash: exec.txHash,
      via: viaCandidate ? "candidate-calldata" : "discovery-tx",
    });
    notify(
      projectMessage({
        plan,
        action:
          "✅ <b>Automatic mint submitted</b>" +
          (viaCandidate ? " (candidate calldata)" : ""),
        detail: exec.txHash
          ? `Transaction: <code>${exec.txHash}</code>\nhttps://bscscan.com/tx/${exec.txHash}`
          : JSON.stringify(exec.raw).slice(0, 400),
      }),
    );
  } catch (e) {
    log.error("minter", `Mint abandoned for ${plan.name}: ${e.message}`);
    store.recordAttempt(eventId, plan.contract, "mint-failed", {
      reason: String(e.message).slice(0, 500),
    });
    // A rejected preview is not broadcast on-chain and incurs no gas cost; include common causes in the notification.
    notify(
      projectMessage({
        plan,
        action:
          "🟡 <b>Simulation failed; abandoned automatically</b> (not broadcast; no funds spent)",
        detail: String(e.message)
          .replace(
            /^baw contract-call preview failed: /,
            "Binance simulation rejected: ",
          )
          .slice(0, 400),
      }),
    );
  }
}
