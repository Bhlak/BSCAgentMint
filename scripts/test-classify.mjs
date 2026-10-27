// Offline test: validate the classification flow (RPC → classification → calldata) with real captured events.
import { initProxyForFetch } from "../src/proxy.js";
import { buildMintPlan } from "../src/classify.js";
import { rpc } from "../src/rpc.js";
import { wallet } from "../src/baw.js";

await initProxyForFetch();

const fixtures = [
  {
    schemaVersion: 1,
    type: "project.new",
    eventId: "bsc:0x81bb9368aca3dfd911a9ec9512353c8803d0ed1d",
    chain: "bsc",
    contractAddress: "0x81bb9368aca3dfd911a9ec9512353c8803d0ed1d",
    name: "CZ Drip",
    imageUrl: null,
    projectUrl: null,
    xUrl: null,
    transactionHash:
      "0x55693e8867dd612043fffbb8c1b8660d626df9895e9cbfdd056baab9ba3d30d7",
    mintQuantity: 10,
    valueNative: "0.0012",
    priceConfirmed: true,
    nativeSymbol: "BNB",
    maxSupply: null,
    functionName: "mint",
    mintedAt: "2026-10-25T13:58:39.000Z",
    discoveredAt: "2026-10-25T13:58:39.974Z",
    cursor: 22,
  },
  {
    schemaVersion: 1,
    type: "project.new",
    eventId: "bsc:0xbe9624e8e10276fdaefbe6057cb1f13c3dee07bf",
    chain: "bsc",
    contractAddress: "0xbe9624e8e10276fdaefbe6057cb1f13c3dee07bf",
    name: "Leading Sheep",
    imageUrl: null,
    projectUrl: null,
    xUrl: null,
    transactionHash:
      "0x18f75bf6b8ed8cc49d05ff7b6fe53cf7ea00d7b891f8ae845bcfd02eadd667cf",
    mintQuantity: 1,
    valueNative: null,
    priceConfirmed: false,
    nativeSymbol: "BNB",
    maxSupply: null,
    functionName: "mint",
    mintedAt: "2026-10-25T13:58:48.000Z",
    discoveredAt: "2026-10-25T13:58:49.459Z",
    cursor: 23,
  },
];

for (const ev of fixtures) {
  const plan = await buildMintPlan(
    ev,
    "0x0000000000000000000000000000000000000000",
  );
  console.log(
    JSON.stringify(
      {
        name: plan.name,
        kind: plan.kind,
        valueWei: String(plan.valueWei),
        priceSource: plan.priceSource,
        inputDataHead: plan.inputData ? plan.inputData.slice(0, 10) : null,
        note: plan.note,
      },
      null,
      2,
    ),
  );
}

// When baw is not signed in, these should return null / UNCONNECTED without throwing.
console.log(
  "baw status:",
  await wallet.status().catch((e) => "ERR " + e.message.slice(0, 80)),
);
process.exit(0);
