import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getWsProxyAgent } from "./proxy.js";
import { notify } from "./telegram.js";

/**
 * mintgo BSC new-project stream client.
 * - Bearer authentication
 * - Automatic reconnect with exponential backoff; resume with ?since=<cursor>
 * - Increase backoff for server-side 429 rate limits (starting at 2 minutes, up to 10 minutes)
 * - Notify after 30 minutes disconnected (at most once every 2 hours), and notify when reconnected
 * Events: "ready" (info) / "event" (raw project.new event)
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
    this.rateLimited = false;
    this.lastOpenAt = 0;
    this.downAlertAt = 0;
    this.wasDown = false;
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
    log.info("stream", `Connecting to ${url}`);
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${config.mintgo.apiKey}` },
      agent: getWsProxyAgent(),
      handshakeTimeout: 20_000,
    });
    this.ws = ws;
    this.lastMsgAt = Date.now();

    ws.on("open", () => {
      this.backoff = 0;
      log.info("stream", "Connected; waiting for events");
      this.pingTimer = setInterval(() => {
        try {
          ws.ping();
        } catch {}
      }, 30_000);
      this.watchTimer = setInterval(() => {
        if (Date.now() - this.lastMsgAt > 180_000) {
          log.warn("stream", "No messages for 3 minutes; forcing reconnect");
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
        log.warn("stream", "Non-JSON message: " + raw.toString().slice(0, 200));
        return;
      }
      if (msg.type === "ready") {
        log.info(
          "stream",
          `ready cursor=${msg.cursor} expiresAt=${msg.expiresAt}`,
        );
        this.onCursor?.(msg.cursor);
        this.emit("ready", msg);
      } else if (msg.type === "caught_up") {
        log.info("stream", `Caught up; cursor=${msg.cursor}`);
      } else if (msg.type === "project.new") {
        if (Number.isFinite(msg.cursor)) this.onCursor?.(msg.cursor);
        this.emit("event", msg);
      } else {
        log.info(
          "stream",
          "Other message type: " + raw.toString().slice(0, 300),
        );
      }
    });

    ws.on("open", () => {
      const wasDown = this.lastOpenAt > 0 && this.wasDown;
      this.backoff = 0;
      this.rateLimited = false;
      this.lastOpenAt = Date.now();
      this.wasDown = false;
      log.info("stream", "Connected; waiting for events");
      if (wasDown)
        notify("🟢 <b>mintgo stream reconnected</b>; monitoring new projects.");
      this.pingTimer = setInterval(() => {
        try {
          ws.ping();
        } catch {}
      }, 30_000);
      this.watchTimer = setInterval(() => {
        if (Date.now() - this.lastMsgAt > 180_000) {
          log.warn("stream", "No messages for 3 minutes; forcing reconnect");
          ws.terminate();
        }
      }, 30_000);
    });

    ws.on("pong", () => {
      this.lastMsgAt = Date.now();
    });

    ws.on("error", (e) => {
      if (/429/.test(e.message)) {
        this.rateLimited = true;
        log.warn(
          "stream",
          "Server rate limited (429); increasing reconnect delay",
        );
      }
      log.error("stream", `Error: ${e.message}`);
    });

    ws.on("close", (code, reason) => {
      clearInterval(this.pingTimer);
      clearInterval(this.watchTimer);
      if (this.closed) return;
      this.wasDown = true;
      // Notify if disconnected for more than 30 minutes (at most once every 2 hours).
      if (
        this.lastOpenAt > 0 &&
        Date.now() - this.lastOpenAt > 30 * 60_000 &&
        Date.now() - this.downAlertAt > 2 * 3600_000
      ) {
        this.downAlertAt = Date.now();
        notify(
          "🔴 <b>mintgo stream has been disconnected for over 30 minutes</b> and is still reconnecting. If it does not recover, check whether the mintgo API key has expired or been rate-limited; reset it at mintgo.fun, update .env, and restart.",
        );
      }
      const r = reason?.toString() || "";
      log.warn(
        "stream",
        `Connection closed code=${code} ${r}; reconnecting in ${Math.round(this.delay() / 1000)}s`,
      );
      this.reconnectTimer = setTimeout(() => this.connect(), this.delay());
      this.backoff = Math.min(this.backoff + 1, 6);
    });
  }

  delay() {
    if (this.rateLimited) {
      // Rate limited: start at 2 minutes, double up to a 10-minute maximum.
      return (
        Math.min(600_000, 120_000 * 2 ** Math.min(this.backoff, 3)) +
        Math.floor(Math.random() * 5000)
      );
    }
    return (
      Math.min(60_000, 1000 * 2 ** this.backoff) +
      Math.floor(Math.random() * 800)
    );
  }
}
