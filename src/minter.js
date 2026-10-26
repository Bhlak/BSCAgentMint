import { config } from "./config.js";
import { log } from "./logger.js";
import { store } from "./state.js";
import { rpc } from "./rpc.js";
import { buildMintPlan, bnbToWei } from "./classify.js";
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
    return true; // RPC 拿不到时放行到 preview（币安侧还会模拟）
  }
}

/**
 * 处理一条 project.new 事件：判定 → 安全闸门 → baw preview/execute → 通知。
 * 全程串行调用（index.js 里有队列），这里不用考虑并发。
 */
export async function handleEvent(event) {
  const eventId = event.eventId;
  if (!eventId || !event.contractAddress) {
    log.warn("minter", "事件缺少 eventId/contractAddress，忽略");
    return;
  }

  store.appendEvent(event);

  if (store.hasSeen(eventId)) {
    log.info("minter", `重复事件 ${eventId}，跳过`);
    return;
  }
  store.markSeen(eventId);

  const prev = store.attemptOf(eventId);
  if (prev) {
    log.info("minter", `事件 ${eventId} 已处理过（${prev.status}），跳过`);
    return;
  }

  log.info("minter", `新项目: ${event.name || "?"} ${event.contractAddress} valueNative=${event.valueNative} confirmed=${event.priceConfirmed} fn=${event.functionName}`);

  const plan = await buildMintPlan(event, walletState.address);
  log.info("minter", `判定 kind=${plan.kind} value=${plan.valueWei}n source=${plan.priceSource} note=${plan.note}`);

  // ---- 分类闸门 ----
  if (plan.kind === "unknown") {
    store.recordAttempt(eventId, plan.contract, "unknown-price", { reason: plan.note });
    notify(projectMessage({ plan, action: "❓ <b>价格未知的新项目</b>（未自动 mint）" }));
    return;
  }
  if (plan.kind === "forbidden") {
    store.recordAttempt(eventId, plan.contract, "forbidden", { reason: plan.note });
    notify(projectMessage({ plan, action: "🚫 <b>可疑项目，已拦截</b>", detail: plan.note }));
    return;
  }
  if (plan.kind === "paid") {
    const maxWei = bnbToWei(config.mint.maxValueBnb);
    if (plan.valueWei > maxWei) {
      store.recordAttempt(eventId, plan.contract, "paid-skip", { reason: `花费超出 MAX_VALUE_BNB=${config.mint.maxValueBnb}` });
      if (config.notify.nonFree) {
        notify(projectMessage({ plan, action: "💰 <b>付费项目，未自动 mint</b>" }));
      } else {
        log.info("minter", "付费项目，未通知");
      }
      return;
    }
    // 落在允许范围内的付费 mint 继续往下走
  }

  if (!config.autoMint) {
    store.recordAttempt(eventId, plan.contract, "auto-off");
    notify(projectMessage({ plan, action: "🔔 <b>新项目（自动 mint 已关闭）</b>" }));
    return;
  }

  // ---- 执行前安全闸门 ----
  const allow = store.dailyAllowance(config.mint.maxPerDay);
  if (allow <= 0) {
    store.recordAttempt(eventId, plan.contract, "daily-cap");
    notify(projectMessage({ plan, action: "⛔ <b>已达每日 mint 上限，本项目跳过</b>" }));
    return;
  }

  if (!plan.inputData) {
    store.recordAttempt(eventId, plan.contract, "no-calldata", { reason: plan.note });
    notify(projectMessage({ plan, action: "⚠️ <b>免费项目但无法构造 calldata，未 mint</b>", detail: plan.note }));
    return;
  }

  if (!(await hasContractCode(plan.contract))) {
    store.recordAttempt(eventId, plan.contract, "no-code");
    notify(projectMessage({ plan, action: "🚫 <b>合约无代码（可能是假部署），未 mint</b>" }));
    return;
  }

  if (!walletState.connected || !walletState.address) {
    // 懒重查：用户扫码登录后不必重启服务，最多每 10 分钟探测一次
    if (Date.now() - (walletState.lastProbeAt || 0) > 10 * 60_000) {
      walletState.lastProbeAt = Date.now();
      try {
        const st = await wallet.status();
        if (String(st).toUpperCase() === "CONNECTED") {
          walletState.connected = true;
          walletState.address = await wallet.address();
          log.info("minter", `baw 已登录（懒检测）地址=${walletState.address}`);
        }
      } catch {}
    }
  }
  if (!walletState.connected || !walletState.address) {
    store.recordAttempt(eventId, plan.contract, "wallet-unconnected");
    const now = Date.now();
    if (now - walletState.warnedAt > 6 * 3600_000) {
      walletState.warnedAt = now;
      notify(projectMessage({
        plan,
        action: "🔐 <b>发现可 mint 项目，但 baw 未登录</b>",
        detail: "运行 npm run signin 扫码登录后即可自动 mint",
      }));
    }
    return;
  }

  const bal = await wallet.bnbBalance();
  if (bal != null) {
    const need = Number(plan.valueWei) / 1e18 + config.mint.bnbReserve;
    if (bal < need) {
      store.recordAttempt(eventId, plan.contract, "low-balance", { reason: `BNB 余额 ${bal} 低于阈值` });
      notify(projectMessage({ plan, action: "⛽ <b>BNB 余额不足（低于保留线），未 mint</b>", detail: `余额 ${bal} BNB` }));
      return;
    }
  }

  if (config.dryRun) {
    store.recordAttempt(eventId, plan.contract, "dry-run", {
      to: plan.contract,
      value: String(plan.valueWei),
      inputData: plan.inputData,
    });
    notify(projectMessage({
      plan,
      action: "🧪 <b>DRY-RUN：本应自动 mint（已拦截在广播前）</b>",
      detail: `to=${plan.contract} value=${plan.valueWei} data=${plan.inputData.slice(0, 20)}…`,
    }));
    return;
  }

  // ---- 执行：baw preview（币安侧模拟）→ execute ----
  try {
    log.info("minter", `preview: to=${plan.contract} value=${plan.valueWei} data=${plan.inputData.slice(0, 34)}…`);
    const { requestId } = await wallet.contractCallPreview({
      from: walletState.address,
      to: plan.contract,
      valueWei: plan.valueWei,
      inputData: plan.inputData,
    });
    log.info("minter", `preview OK requestId=${requestId}，执行`);
    const exec = await wallet.contractCallExecute(requestId);
    log.info("minter", `execute 完成 status=${exec.status} tx=${exec.txHash}`);
    store.recordAttempt(eventId, plan.contract, "minted", { txHash: exec.txHash });
    notify(projectMessage({
      plan,
      action: "✅ <b>自动 mint 已提交</b>",
      detail: exec.txHash ? `交易: <code>${exec.txHash}</code>\nhttps://bscscan.com/tx/${exec.txHash}` : JSON.stringify(exec.raw).slice(0, 400),
    }));
  } catch (e) {
    log.error("minter", `mint 失败 ${plan.name}: ${e.message}`);
    store.recordAttempt(eventId, plan.contract, "mint-failed", { reason: String(e.message).slice(0, 500) });
    notify(projectMessage({ plan, action: "❌ <b>自动 mint 失败</b>", detail: String(e.message).slice(0, 500) }));
  }
}
