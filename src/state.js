import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve("data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");

const SEEN_CAP = 1000;
const ATTEMPT_CAP = 2000;

const DEFAULT_STATE = {
  cursor: 0,
  seenEventIds: [],
  attempts: {}, // eventId -> { status, txHash?, reason?, at }
  day: "",
  mintedToday: 0,
  keyExpiryWarnedOn: "",
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function load() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

let state = load();

function save() {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

export const store = {
  get cursor() {
    return state.cursor;
  },
  setCursor(n) {
    if (Number.isFinite(n) && n > state.cursor) {
      state.cursor = n;
      save();
    }
  },
  hasSeen(eventId) {
    return state.seenEventIds.includes(eventId);
  },
  markSeen(eventId) {
    state.seenEventIds.unshift(eventId);
    if (state.seenEventIds.length > SEEN_CAP)
      state.seenEventIds = state.seenEventIds.slice(0, SEEN_CAP);
    save();
  },
  attemptOf(eventId) {
    return state.attempts[eventId];
  },
  recordAttempt(eventId, contract, status, extra = {}) {
    const prev = state.attempts[eventId];
    // Do not roll back state for a contract that has already been minted successfully.
    if (prev?.status === "minted") return;
    state.attempts[eventId] = {
      contract,
      status,
      at: new Date().toISOString(),
      ...extra,
    };
    const keys = Object.keys(state.attempts);
    if (keys.length > ATTEMPT_CAP) {
      for (const k of keys.slice(0, keys.length - ATTEMPT_CAP))
        delete state.attempts[k];
    }
    if (status === "minted") this.bumpDaily();
    save();
  },
  dailyAllowance(maxPerDay) {
    const today = new Date().toISOString().slice(0, 10);
    if (state.day !== today) {
      state.day = today;
      state.mintedToday = 0;
      save();
    }
    return Math.max(0, maxPerDay - state.mintedToday);
  },
  bumpDaily() {
    const today = new Date().toISOString().slice(0, 10);
    if (state.day !== today) {
      state.day = today;
      state.mintedToday = 0;
    }
    state.mintedToday += 1;
    save();
  },
  /** Send an API key expiration reminder at most once per day. */
  shouldWarnKeyExpiry() {
    const today = new Date().toISOString().slice(0, 10);
    if (state.keyExpiryWarnedOn === today) return false;
    state.keyExpiryWarnedOn = today;
    save();
    return true;
  },
  appendEvent(event) {
    try {
      fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + "\n");
    } catch {
      /* ignore */
    }
  },
  snapshot() {
    return { ...state };
  },
};
