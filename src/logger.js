import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.resolve("logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "app.log");

function write(level, tag, args) {
  const line =
    `[${new Date().toISOString()}] [${level}] [${tag}] ` +
    args.map(fmt).join(" ");
  console.log(
    `${level === "ERROR" ? "✖" : level === "WARN" ? "⚠" : "·"} ${line.slice(line.indexOf("]") + 1)}`,
  );
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* A log write failure is non-fatal. */
  }
}

function fmt(x) {
  if (typeof x === "string") return x;
  if (x instanceof Error) return x.stack || x.message;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

export const log = {
  info: (tag, ...a) => write("INFO", tag, a),
  warn: (tag, ...a) => write("WARN", tag, a),
  error: (tag, ...a) => write("ERROR", tag, a),
};
