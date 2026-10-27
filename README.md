# BSCAgentMint — BSC New Project Free Mint Sentinel

Monitors the real-time BSC New Project API stream from [mintgo.fun](https://mintgo.fun). When it detects a new NFT project with a **free mint**, it automatically mints using your **Binance Agentic Wallet** (Agent ID wallet), **without requiring manual confirmation**. Uncertain cases and failures are reported through **Telegram**.

```
mintgo WS stream ──► Free-mint classification (first on-chain mint transaction is authoritative) ──► Safety gates ──► baw contract-call preview ──► execute ──► Telegram report
                                                                                       │
                                                                                       └─ Unknown / paid / risky ──► Telegram notification only
```

## Features

- **Real-time monitoring**: `wss://mintgo.fun/api/bsc-projects/stream`, with Bearer authentication; reconnects with exponential backoff after disconnects, resumes from `?since=<cursor>`, and deduplicates by `eventId`
- **Free-mint classification (when in doubt, skip rather than spend incorrectly)**:
  1. Fetches the discoverer's first mint transaction included with the event (via a public BSC RPC). On-chain `value` and `calldata` are authoritative: `value=0` → free; `value>0` → paid
  2. If the transaction is unavailable, uses event fields (`valueNative` + `priceConfirmed`)
  3. If the price is still unknown, simulates `mint()` with `value=0` using `eth_call`; only a successful simulation is treated as free
- **Automatic execution**: Copies the discoverer's calldata exactly (including quantity and price), then uses Binance's official CLI [`baw`](https://www.npmjs.com/package/@binance/agentic-wallet) (`@binance/agentic-wallet`) to run `contract-call preview` (simulated by Binance) followed by `execute`; the private key is never accessed (MPC Keyless)
- **Telegram notifications**: Mint success/failure, paid or unknown projects, daily limit reached, insufficient balance, and API key nearing expiration
- **Automatically detects sign-in**: After signing in to `baw` via QR code, the service detects it lazily on the next event and enters mint mode without a restart

## Quick Start

### 1. Run locally

```bash
npm install
cp .env.example .env        # Set MINTGO_API_KEY (required) and Telegram settings (optional)
npx baw auth signin         # Scan the QR code in the Binance app to sign in to Agentic Wallet (one-time)
npm start                   # Run in the foreground; first observe a cycle with DRY_RUN=true
```

### 2. Docker / NAS deployment (recommended for long-running use)

```bash
docker compose up -d --build
# First-time sign-in: start a background sign-in container and scan the QR link shown in its logs
docker compose run -d --name baw-signin bscagentmint node scripts/signin.mjs
docker logs baw-signin      # Copy the https://app.binance.com/uni-qr/xxx link into a browser and scan
# After sign-in: docker rm baw-signin
```

Key points:

- `BINANCE_INSTANCE_ID` is set to a custom, fixed value in `docker-compose.yml` — **baw sessions are encrypted using a device fingerprint**, so keeping this value fixed along with the `baw-session` volume preserves the session across container rebuilds
- `.env`, `data`, `logs`, and the baw session are all mounted as volumes; the image contains no secrets
- `restart: unless-stopped` enables startup on boot and automatic restarts after crashes

### 3. NAS one-click deployment helper (optional)

[`deploy/nas.py`](deploy/nas.py) wraps the full workflow—from probing and uploading through building, QR sign-in, and status checks. Credentials are read from the environment variables `NAS_HOST / NAS_USER / NAS_PASS / NAS_REMOTE_DIR / NAS_PROXY_URL` and are not stored in code:

```bash
pip install paramiko python-dotenv
python deploy/nas.py probe     # Check system / Docker / disk
python deploy/nas.py push      # Upload code (automatically rewrites PROXY_URL in the NAS-side .env)
python deploy/nas.py up        # Build the image and start it
python deploy/nas.py signin    # Start a sign-in container in the background and print the QR link
python deploy/nas.py status    # Container status + log tail + baw status
```

### Telegram setup

1. Find **@BotFather** → send `/newbot` → get a bot token
2. **Send your bot a message** (a bot cannot initiate a conversation)
3. Set `TELEGRAM_BOT_TOKEN` in `.env`; find `TELEGRAM_CHAT_ID` using `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Run `npm run test:tg` to verify

## Configuration (`.env`)

| Key                  | Default     | Description                                                                                            |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| `AUTO_MINT`          | `true`      | Set to `false` to notify only without executing                                                        |
| `DRY_RUN`            | `false`     | When `true`, stops immediately before execution (notifies only; does not broadcast)                    |
| `MAX_VALUE_BNB`      | `0`         | Maximum allowed spend per mint; **0 = only mint when confirmed free**                                  |
| `MINT_UNKNOWN_PRICE` | `false`     | Whether to attempt mints when the price is unknown (default: notify only)                              |
| `MAX_MINTS_PER_DAY`  | `20`        | Daily automatic mint limit                                                                             |
| `BNB_RESERVE`        | `0.003`     | Minimum BNB balance to keep in reserve for gas; pauses if balance drops below this                     |
| `MINT_QUANTITY_MODE` | `replicate` | Replicate the quantity and calldata of the discoverer's first mint                                     |
| `NOTIFY_NON_FREE`    | `true`      | Whether to notify about paid projects                                                                  |
| `PROXY_URL`          | empty       | Outbound proxy (injected consistently into WS, fetch, and baw subprocesses; leave empty if not needed) |
| `BSC_RPC_URLS`       | built-in    | Comma-separated list; fails over automatically                                                         |

## Safety Gates (in order)

1. Deduplication: do not mint duplicate `eventId`s or previously processed items; mint at most once per contract
2. Only mint for free projects (`MAX_VALUE_BNB` controls the threshold; default is 0)
3. Block sensitive calldata operations (`approve` / `setApprovalForAll` / `transferFrom` / `permit`…)
4. Require the contract to have code (prevents fake deployment addresses)
5. Enforce the daily mint limit (`MAX_MINTS_PER_DAY`)
6. Enforce the minimum BNB balance reserve for gas
7. If Binance-side `preview` simulation fails, skip immediately (nothing is sent on-chain)

Additionally, the daily limits and token permissions configured for Agentic Wallet in the **Binance app are hard limits enforced by Binance**. You can revoke the script's access at any time by signing out of Agentic Wallet in the app.

## Common Commands

```bash
npm start             # Start the service
npm run signin        # Sign in to baw using the QR code
npm run test:tg       # Test Telegram notifications
npm run test:classify # Run offline classification tests against real historical events
npm run probe         # Connect to the stream directly and print raw events (debugging)
npx baw wallet balance --binanceChainId 56   # Wallet balance
npx baw wallet tx-history                    # Transaction history
```

## Networking

`PROXY_URL` is the single proxy configuration point (in `.env`): the WebSocket stream, RPC/Telegram fetch requests, and baw CLI subprocesses all receive the proxy explicitly. The setup **does not depend on terminal environment variables**. Leave it empty to connect directly. Access to Binance domains from mainland China may be affected by DNS poisoning; a proxy is usually needed.

## Data and Logs

- `data/state.json`: Cursor, deduplication data, daily counts, and processing results for each event
- `data/events.jsonl`: All raw events received (for auditing)
- `logs/app.log`: Application log

## Known Limitations

- mintgo API keys have an expiration date (shown on the creation page). The service sends a reminder 48 hours before expiration; after resetting it on mintgo.fun, update `.env` and restart
- For projects where the discoverer minted through a router or aggregator, direct calldata may be unavailable. The service falls back to simulation for classification and skips the mint if uncertain
- When `MAX_VALUE_BNB>0`, paid mint costs are conservatively estimated as `unit price × quantity`; the actual result is determined by Binance preview
- Free-mint project quality varies. This tool only automates free mints and is not investment advice; use it at your own risk

## License

MIT
