import { ethers } from "ethers";
import { rpc } from "./rpc.js";

// Function selectors that must never be executed on the user's behalf (approval/transfer operations).
const FORBIDDEN_SELECTORS = new Set(
  [
    "approve(address,uint256)",
    "setApprovalForAll(address,bool)",
    "transferFrom(address,address,uint256)",
    "safeTransferFrom(address,address,uint256)",
    "safeTransferFrom(address,address,uint256,bytes)",
    "transfer(address,uint256)",
    "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  ].map((sig) => ethers.id(sig).slice(0, 10)),
);

export function bnbToWei(bnb) {
  return BigInt(Math.round(Number(bnb) * 1e15)) * 1000n;
}

/**
 * Generate candidate signatures from functionName, simulate them with eth_call and value=0, and return calldata that succeeds.
 * Used as a fallback when a free mint's discovery calldata is unavailable, and as an alternative retry if preview is rejected.
 */
export async function findMintCandidate(event, walletAddress) {
  if (!event.functionName || !walletAddress) return null;
  const fn = String(event.functionName).replace(/\(.*/, "");
  const sigs = [
    ...new Set([
      `${fn}()`,
      `${fn}(uint256)`,
      `${fn}(uint256,uint256)`,
      "publicMint()",
      "mint()",
    ]),
  ];
  for (const sig of sigs) {
    try {
      const selector = ethers.id(sig).slice(0, 10);
      let data = selector;
      const argCount =
        (sig.match(/,/g) || []).length + (sig.includes("(uint256") ? 1 : 0);
      if (argCount >= 1) data += BigInt(1).toString(16).padStart(64, "0");
      if (argCount >= 2) data += BigInt(1).toString(16).padStart(64, "0");
      await rpc.ethCall({
        to: (event.contractAddress || "").toLowerCase(),
        from: walletAddress,
        data,
        value: "0x0",
      });
      return data;
    } catch {
      /* Candidate unavailable; try the next one. */
    }
  }
  return null;
}

/**
 * Convert a project.new event into an executable mint plan.
 * The authoritative source is the discoverer's first mint transaction (copy on-chain value and calldata exactly);
 * fall back to fields included in the event if the transaction is unavailable.
 */
export async function buildMintPlan(event, walletAddress) {
  const plan = {
    eventId: event.eventId,
    contract: (event.contractAddress || "").toLowerCase(),
    name: event.name || "(unnamed)",
    qty: event.mintQuantity ?? null,
    valueWei: null,
    inputData: null,
    priceSource: null,
    kind: "unknown", // free | paid | unknown | forbidden
    note: "",
  };

  let tx = null;
  if (event.transactionHash) {
    try {
      tx = await rpc.getTx(event.transactionHash);
    } catch (e) {
      plan.note = `Failed to fetch discovery transaction from RPC: ${e.message}`;
    }
  }

  if (tx && tx.to && tx.to.toLowerCase() === plan.contract) {
    plan.valueWei = BigInt(tx.value);
    plan.inputData = tx.input && tx.input !== "0x" ? tx.input : null;
    plan.priceSource = "discovery-tx";
  } else if (tx) {
    plan.note =
      "Discovery transaction recipient does not match the contract (possibly routed); falling back to event fields";
  }

  if (plan.valueWei === null) {
    const v = event.valueNative;
    if (event.priceConfirmed && v != null && Number(v) === 0) {
      plan.valueWei = 0n;
      plan.priceSource = "event-confirmed";
    } else if (event.priceConfirmed && v != null && Number(v) > 0) {
      // Estimate total cost using the discoverer's quantity (conservative overestimate if valueNative is already the total).
      plan.valueWei = bnbToWei(Number(v) * (plan.qty || 1));
      plan.priceSource = "event-confirmed(per×qty)";
    }
  }

  // If calldata is unavailable, generate candidates from functionName and simulate them with eth_call and value=0.
  // A successful simulation confirms a direct free-mint path and can resolve unknown-price projects, including routed mints.
  if (!plan.inputData && event.functionName && walletAddress) {
    const fn = String(event.functionName).replace(/\(.*/, "");
    const sigs = [
      ...new Set([`${fn}()`, `${fn}(uint256)`, "publicMint()", "mint()"]),
    ];
    for (const sig of sigs) {
      try {
        const selector = ethers.id(sig).slice(0, 10);
        const data = sig.includes("(uint256)")
          ? selector + BigInt(1).toString(16).padStart(64, "0")
          : selector;
        await rpc.ethCall({
          to: plan.contract,
          from: walletAddress,
          data,
          value: "0x0",
        });
        plan.inputData = data;
        if (plan.valueWei === null) {
          plan.valueWei = 0n;
          plan.priceSource = `sim:free(${sig})`;
        } else {
          plan.priceSource += ` +sim:${sig}`;
        }
        break;
      } catch {
        /* Candidate unavailable; try the next one. */
      }
    }
  }

  if (plan.valueWei === null) {
    plan.kind = "unknown";
    return plan;
  }

  plan.kind = plan.valueWei === 0n ? "free" : "paid";

  if (plan.inputData) {
    const sel = plan.inputData.slice(0, 10).toLowerCase();
    if (FORBIDDEN_SELECTORS.has(sel)) {
      plan.kind = "forbidden";
      plan.note = `Discovery transaction calldata contains a sensitive operation (${sel}); refusing to execute`;
    }
  }

  return plan;
}
