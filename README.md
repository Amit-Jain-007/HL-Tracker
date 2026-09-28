# Hyperliquid tracker — GitHub Actions version

GitHub runs one check every ~5 minutes for free and sends alerts to Telegram.
No server, no card. Alerts can be a few minutes late (GitHub's minimum schedule
is 5 minutes and runs are best-effort).

## Setup

1. Create a GitHub account, then a **new public repository** (e.g. `hl-tracker`).
   Public repos get free Actions minutes; private ones have a small monthly limit
   that a 5-minute schedule would use up. Your token and wallets stay in encrypted
   secrets, and logs hide alert details, so nothing sensitive is public.
2. Upload these files to the repo (Add file > Upload files):
   `tracker.js`, `.gitignore`, `config.example.json`, and the `.github` folder.
   **Do NOT upload `config.json`** (it contains your bot token).
   If the `.github` folder doesn't upload, use Add file > Create new file, type
   `.github/workflows/tracker.yml` as the name, and paste the file contents.
3. Repo > Settings > Secrets and variables > Actions > New repository secret.
   Add three secrets:
   - `TG_TOKEN`   your Telegram bot token
   - `TG_CHAT_ID` your chat ID
   - `HL_WALLETS` your wallets as JSON, with FULL addresses:
     `[{"address":"0x...","nickname":"Propr Hedging"},{"address":"0x...","nickname":"CRCL GOD"}]`
4. (Optional) Change thresholds: Settings > Secrets and variables > Actions >
   Variables tab > New repository variable named `HL_SETTINGS`, for example:
   `{"largeTradeUsd":20000,"pnlSwingUsd":1000,"liqProximityPct":8}`
5. Go to the Actions tab, pick "Hyperliquid tracker", click Run workflow.
   The first run only records a baseline (no alerts). After that it runs
   automatically every ~5 minutes.

## Changing wallets later
Edit the `HL_WALLETS` secret. It applies on the next run.

## Good to know
- GitHub may pause scheduled workflows in a public repo after ~60 days with no
  repo activity. If alerts stop, open the Actions tab and re-enable it.
- The tracker's memory (state) is kept in the Actions cache. If it is ever
  cleared, the next run just records a fresh baseline.
- You can still run it anywhere with `node tracker.js` using a `config.json`.
