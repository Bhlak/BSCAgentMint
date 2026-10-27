// Temporary probe: connect to the mintgo BSC new-project stream and print raw messages to verify authentication and event structure.
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

// Exit automatically after 10 minutes to avoid hanging indefinitely.
setTimeout(() => {
  console.log("[timeout] 10min reached, exiting");
  process.exit(0);
}, 600000);
