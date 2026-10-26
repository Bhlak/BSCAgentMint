# BSCAgentMint — BSC 新项目免费 mint 哨兵

监听 [mintgo.fun](https://mintgo.fun) 的 BSC New Project API 实时流，发现**免费 mint** 的新 NFT 项目时，用你的**币安 Agentic Wallet**（Agent ID 钱包）**自动完成 mint，无需人工确认**；拿不准或失败时通过 **Telegram 推送**。

```
mintgo WS 流 ──► 免费判定(链上首笔mint交易为权威) ──► 安全闸门 ──► baw contract-call preview ──► execute ──► Telegram 报告
                                                    │
                                                    └─ 未知/付费/风险 ──► 仅 Telegram 推送
```

## 功能特性

- **实时监听**：`wss://mintgo.fun/api/bsc-projects/stream`，Bearer 鉴权；断线指数退避重连，`?since=<cursor>` 断点续传，按 `eventId` 去重
- **免费判定（宁可漏掉，不可错打）**：
  1. 拉取事件自带的**发现者首笔 mint 交易**（BSC 公共 RPC），链上 `value` 和 `calldata` 是权威：`value=0` → 免费；`value>0` → 付费
  2. 拿不到交易时用事件字段（`valueNative` + `priceConfirmed`）
  3. 仍未知时用 `eth_call` 以 `value=0` 模拟 `mint()`，模拟通过才算免费
- **自动执行**：原样复制发现者的 calldata（含数量与价格），通过币安官方 CLI [`baw`](https://www.npmjs.com/package/@binance/agentic-wallet)（`@binance/agentic-wallet`）的 `contract-call preview`（币安侧先模拟）→ `execute` 广播；全程不接触私钥（MPC Keyless）
- **Telegram 推送**：mint 成功/失败、付费与未知项目提醒、每日上限触发、余额不足、API key 即将过期
- **登录后自动感知**：baw 扫码后无需重启服务，下一个事件时懒检测自动进入 mint 模式

## 快速开始

### 1. 本机运行

```bash
npm install
cp .env.example .env        # 填入 MINTGO_API_KEY（必填）与 Telegram 配置（可选）
npx baw auth signin         # 币安 App 扫码登录 Agentic Wallet（一次性）
npm start                   # 前台运行；建议先用 DRY_RUN=true 观察一轮
```

### 2. Docker / NAS 部署（推荐长期挂机）

```bash
docker compose up -d --build
# 首次登录：起一个后台登录容器，浏览器打开它日志里的二维码链接扫码
docker compose run -d --name baw-signin bscagentmint node scripts/signin.mjs
docker logs baw-signin      # 复制 https://app.binance.com/uni-qr/xxx 到浏览器扫码
# 扫码完成后：docker rm baw-signin
```

要点：

- `BINANCE_INSTANCE_ID` 在 `docker-compose.yml` 里固定为一个自定义值——**baw 会话按设备指纹加密**，固定它 + `baw-session` 卷可以让会话在容器重建后依然有效
- `.env` / `data` / `logs` / baw 会话全部走卷挂载，镜像不含任何密钥
- `restart: unless-stopped` 保证开机自启、崩溃自拉

### 3. NAS 一键部署助手（可选）

[`deploy/nas.py`](deploy/nas.py) 封装了从探测、上传、构建、扫码到查状态的完整流程（凭据从环境变量 `NAS_HOST / NAS_USER / NAS_PASS / NAS_REMOTE_DIR / NAS_PROXY_URL` 读取，不写入代码）：

```bash
pip install paramiko python-dotenv
python deploy/nas.py probe     # 探测系统 / docker / 磁盘
python deploy/nas.py push      # 上传代码（自动改写 NAS 侧 .env 的 PROXY_URL）
python deploy/nas.py up        # 构建镜像并启动
python deploy/nas.py signin    # 后台起登录容器并打印二维码链接
python deploy/nas.py status    # 容器状态 + 日志尾部 + baw 状态
```

### Telegram 配置

1. 找 **@BotFather** → `/newbot` → 拿到 bot token
2. **给自己的 bot 发一条消息**（bot 无法主动发起对话）
3. `.env` 填 `TELEGRAM_BOT_TOKEN`；`TELEGRAM_CHAT_ID` 可用 `https://api.telegram.org/bot<TOKEN>/getUpdates` 查到
4. `npm run test:tg` 验证

## 配置（.env）

| 键 | 默认 | 说明 |
|---|---|---|
| `AUTO_MINT` | `true` | `false` 时只推送不执行 |
| `DRY_RUN` | `false` | `true` 时走到执行前一步停下（只推送不广播） |
| `MAX_VALUE_BNB` | `0` | 单笔允许的最大花费；**0 = 只打确认免费的** |
| `MINT_UNKNOWN_PRICE` | `false` | 价格未知是否尝试（默认只推送） |
| `MAX_MINTS_PER_DAY` | `20` | 每日自动 mint 上限 |
| `BNB_RESERVE` | `0.003` | 钱包至少保留的 BNB（gas 储备），低于则暂停 |
| `MINT_QUANTITY_MODE` | `replicate` | 复制发现者首笔 mint 的数量与 calldata |
| `NOTIFY_NON_FREE` | `true` | 是否推送付费项目 |
| `PROXY_URL` | 空 | 出站代理（WS/fetch/baw 子进程统一注入；不需要就留空） |
| `BSC_RPC_URLS` | 内置 | 逗号分隔，自动故障切换 |

## 安全闸门（按顺序）

1. 去重：`eventId` / 已处理过的不重复打；同一合约只打一次
2. 只打免费（`MAX_VALUE_BNB` 控制，默认 0）
3. calldata 敏感操作黑名单（`approve` / `setApprovalForAll` / `transferFrom` / `permit`… 一律拦截）
4. 合约必须有代码（防假部署地址）
5. 每日次数上限（`MAX_MINTS_PER_DAY`）
6. BNB 余额保留线（gas 储备）
7. 币安侧 `preview` 模拟失败 → 直接跳过（不会上链）

再叠一层：**币安 App 里给 Agentic Wallet 设置的每日限额 / 代币范围是币安侧的硬上限**，随时可在 App 里登出 Agentic Wallet 一键吊销脚本权限。

## 常用命令

```bash
npm start             # 启动服务
npm run signin        # 扫码登录 baw
npm run test:tg       # 测试 Telegram 推送
npm run test:classify # 用真实历史事件离线测试判定链
npm run probe         # 裸连流打印原始事件（调试）
npx baw wallet balance --binanceChainId 56   # 钱包余额
npx baw wallet tx-history                    # 执行历史
```

## 网络说明

`PROXY_URL` 是唯一代理入口（`.env`）：WebSocket 流、RPC/Telegram 的 fetch、baw CLI 子进程全部由程序显式注入该代理，**不依赖终端环境变量**。留空则直连。国内环境访问币安域名存在 DNS 污染，通常需要代理。

## 数据与日志

- `data/state.json`：cursor、去重、每日计数、每个事件的处理结果
- `data/events.jsonl`：所有收到的原始事件（审计用）
- `logs/app.log`：运行日志

## 已知边界

- mintgo API key 有有效期（创建页显示 Expires），到期前 48 小时服务会推送提醒；到 mintgo.fun 重置后更新 `.env` 重启即可
- 发现者经由路由/聚合器 mint 的项目拿不到直连 calldata，会走模拟判定，拿不准就只推送不打
- `MAX_VALUE_BNB>0` 时付费花费按 `单价×数量` 保守估算，实际以币安 preview 为准
- 免费 mint 的项目质量参差，本工具只负责"自动打免费"，不构成任何投资建议，风险自负

## License

MIT
