// 临时探针：连接 mintgo BSC 新项目流，打印原始消息，确认鉴权与事件结构
import WebSocket from "ws";
import { getWsProxyAgent } from "./src/proxy.js";

const KEY = process.env.MINTGO_API_KEY;
if (!KEY) {
  console.error("missing MINTGO_API_KEY");
  process.exit(1);
}

const ws = new WebSocket("wss://mintgo.fun/api/bsc-projects/stream", {
  headers: { authorization: `Bearer ${KEY}` },
  agent: getWsProxyAgent(),
});

ws.on("open", () => console.log("[open] connected"));
ws.on("message", (raw) => console.log("[msg]", raw.toString()));
ws.on("close", (code, reason) => {
  console.log("[close]", code, reason.toString());
  process.exit(0);
});
ws.on("error", (e) => console.log("[error]", e.message));

// 10 分钟后自动退出，避免挂死
setTimeout(() => {
  console.log("[timeout] 10min reached, exiting");
  process.exit(0);
}, 600000);
