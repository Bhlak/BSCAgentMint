import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getWsProxyAgent } from "./proxy.js";

/**
 * mintgo BSC 新项目流客户端
 * - Bearer 鉴权
 * - 断线自动重连（指数退避），重连带 ?since=<cursor>
 * - 30s ping 保活，3 分钟无消息强制重连
 * 事件: "ready" (info) / "event" (project.new 原始事件)
 */
export class MintgoStream extends EventEmitter {
  constructor({ getCursor, onCursor }) {
    super();
    this.getCursor = getCursor;
    this.onCursor = onCursor;
    this.ws = null;
    this.backoff = 0;
    this.closed = false;
    this.lastMsgAt = 0;
    this.watchTimer = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    clearInterval(this.watchTimer);
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {}
    }
  }

  url() {
    const cursor = this.getCursor();
    const base = config.mintgo.streamUrl;
    return cursor > 0 ? `${base}?since=${cursor}` : base;
  }

  connect() {
    if (this.closed) return;
    const url = this.url();
    log.info("stream", `连接 ${url}`);
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${config.mintgo.apiKey}` },
      agent: getWsProxyAgent(),
      handshakeTimeout: 20_000,
    });
    this.ws = ws;
    this.lastMsgAt = Date.now();

    ws.on("open", () => {
      this.backoff = 0;
      log.info("stream", "已连接，等待事件");
      this.pingTimer = setInterval(() => {
        try {
          ws.ping();
        } catch {}
      }, 30_000);
      this.watchTimer = setInterval(() => {
        if (Date.now() - this.lastMsgAt > 180_000) {
          log.warn("stream", "3 分钟无消息，强制重连");
          ws.terminate();
        }
      }, 30_000);
    });

    ws.on("message", (raw) => {
      this.lastMsgAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        log.warn("stream", "非 JSON 消息: " + raw.toString().slice(0, 200));
        return;
      }
      if (msg.type === "ready") {
        log.info("stream", `ready cursor=${msg.cursor} expiresAt=${msg.expiresAt}`);
        this.onCursor?.(msg.cursor);
        this.emit("ready", msg);
      } else if (msg.type === "caught_up") {
        log.info("stream", `已追平 cursor=${msg.cursor}`);
      } else if (msg.type === "project.new") {
        if (Number.isFinite(msg.cursor)) this.onCursor?.(msg.cursor);
        this.emit("event", msg);
      } else {
        log.info("stream", "其他消息类型: " + raw.toString().slice(0, 300));
      }
    });

    ws.on("pong", () => {
      this.lastMsgAt = Date.now();
    });

    ws.on("error", (e) => {
      log.error("stream", `错误: ${e.message}`);
    });

    ws.on("close", (code, reason) => {
      clearInterval(this.pingTimer);
      clearInterval(this.watchTimer);
      if (this.closed) return;
      const r = reason?.toString() || "";
      log.warn("stream", `连接关闭 code=${code} ${r}，${this.delay()}ms 后重连`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.delay());
      this.backoff = Math.min(this.backoff + 1, 6);
    });
  }

  delay() {
    return Math.min(60_000, 1000 * 2 ** this.backoff) + Math.floor(Math.random() * 800);
  }
}
