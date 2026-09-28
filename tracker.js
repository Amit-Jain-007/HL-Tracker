// Hyperliquid Wallet Tracker
// Two modes:
//   node tracker.js          -> runs forever (polls every pollInterval seconds)
//   node tracker.js --once   -> runs a single check and exits (used by GitHub Actions)
// Requires Node.js 18+ (built-in fetch).
const fs = require('fs');
const path = require('path');

const ONCE = process.argv.includes('--once');
const QUIET = process.env.QUIET_LOGS === '1'; // hides alert details from logs (useful on public repos)
const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'state.json');
const HL_API = 'https://api.hyperliquid.xyz/info';

const DEFAULT_SETTINGS = {
  tgToken: '', tgChatId: '', pollInterval: 30,
  largeTradeUsd: 10000, pnlSwingUsd: 500, liqProximityPct: 10,
  notifyOpenClose: true, notifyLargeTrade: true, notifyPnlSwing: true,
  notifyLiqRisk: true, notifyDepositWithdraw: true
};

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function saveJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function parseEnvJSON(name) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {
    console.log(`Could not parse ${name} as JSON: ${e.message}`);
    return null;
  }
}

let state = loadJSON(STATE_PATH, {}); // address -> {positions, lastFillTime, lastLedgerTime, liqAlerted, accountValue}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function hlPost(body) {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) { log('Telegram not configured, alert not sent.'); return; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!res.ok) { const body = await res.text(); log('Telegram send failed: ' + body); }
  } catch (e) { log('Telegram send error: ' + e.message); }
}

// Log the alert (unless QUIET_LOGS=1) and send it to Telegram.
async function alert(settings, msg) {
  log(QUIET ? 'Alert sent (details hidden)' : msg);
  await sendTelegram(settings.tgToken, settings.tgChatId, msg);
}

function fmtUsd(n) {
  const num = Number(n);
  if (isNaN(num)) return '-';
  return (num < 0 ? '-' : '') + '$' + Math.abs(num).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// HIP-3 builder-deployed perp dexes (e.g. tokenized stocks) live outside the main perp dex.
let perpDexCache = null, perpDexCacheTime = 0;
async function getPerpDexList() {
  const now = Date.now();
  if (perpDexCache && now - perpDexCacheTime < 10 * 60 * 1000) return perpDexCache;
  try {
    const dexs = await hlPost({ type: 'perpDexs' });
    const names = (dexs || []).filter(d => d && d.name).map(d => d.name);
    perpDexCache = ['', ...names];
  } catch (e) {
    perpDexCache = perpDexCache || [''];
  }
  perpDexCacheTime = now;
  return perpDexCache;
}

async function checkWallet(w, settings) {
  const addr = w.address;
  const firstSeen = !state[addr];
  if (firstSeen) {
    state[addr] = {
      positions: {},
      lastFillTime: Date.now() - settings.pollInterval * 1000,
      lastLedgerTime: Date.now() - settings.pollInterval * 1000,
      liqAlerted: {}
    };
  }
  const st = state[addr];
  const label0 = w._label || w.nickname;

  try {
    const dexList = await getPerpDexList();
    const newPositions = {};
    let accountValue = 0;

    for (const dex of dexList) {
      const cs = await hlPost({ type: 'clearinghouseState', user: addr, dex });
      accountValue += parseFloat(cs?.marginSummary?.accountValue ?? '0');
      (cs.assetPositions || []).forEach(ap => {
        const p = ap.position;
        const szi = parseFloat(p.szi);
        if (Math.abs(szi) < 1e-9) return;
        const key = dex ? `${p.coin}@${dex}` : p.coin;
        newPositions[key] = {
          coin: p.coin, dex: dex || null, szi,
          entryPx: parseFloat(p.entryPx),
          unrealizedPnl: parseFloat(p.unrealizedPnl),
          liquidationPx: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
          positionValue: parseFloat(p.positionValue)
        };
      });
    }

    const oldPositions = st.positions || {};

    // On the very first check of a wallet we only record a baseline, so you
    // don't get an "Opened" alert for every position it already holds.
    if (settings.notifyOpenClose && !firstSeen) {
      for (const key of Object.keys(newPositions)) {
        if (!oldPositions[key]) {
          const p = newPositions[key];
          const side = p.szi > 0 ? 'Long' : 'Short';
          const label = p.dex ? `${p.coin} (${p.dex})` : p.coin;
          await alert(settings, `🟢 [${w.nickname}] Opened ${side} ${label} — size ${Math.abs(p.szi)} @ ${fmtUsd(p.entryPx)}`);
        }
      }
      for (const key of Object.keys(oldPositions)) {
        if (!newPositions[key]) {
          const p = oldPositions[key];
          const label = p.dex ? `${p.coin} (${p.dex})` : p.coin;
          await alert(settings, `🔴 [${w.nickname}] Closed ${label} position`);
        }
      }
    }

    if (settings.notifyPnlSwing) {
      for (const key of Object.keys(newPositions)) {
        const np = newPositions[key], op = oldPositions[key];
        if (op) {
          const diff = np.unrealizedPnl - op.unrealizedPnl;
          if (Math.abs(diff) >= settings.pnlSwingUsd) {
            const dir = diff > 0 ? '📈 up' : '📉 down';
            const label = np.dex ? `${np.coin} (${np.dex})` : np.coin;
            await alert(settings, `${dir} [${w.nickname}] ${label} uPnL moved ${fmtUsd(diff)} → now ${fmtUsd(np.unrealizedPnl)}`);
          }
        }
      }
    }

    if (settings.notifyLiqRisk) {
      for (const key of Object.keys(newPositions)) {
        const p = newPositions[key];
        if (p.liquidationPx && p.positionValue) {
          const markPx = Math.abs(p.positionValue / p.szi);
          const proximityPct = Math.abs(markPx - p.liquidationPx) / markPx * 100;
          const near = proximityPct <= settings.liqProximityPct;
          const label = p.dex ? `${p.coin} (${p.dex})` : p.coin;
          if (near && !st.liqAlerted[key]) {
            await alert(settings, `⚠️ [${w.nickname}] ${label} is ${proximityPct.toFixed(1)}% from liquidation (liq px ${fmtUsd(p.liquidationPx)})`);
            st.liqAlerted[key] = true;
          } else if (!near) {
            st.liqAlerted[key] = false;
          }
        }
      }
    }

    if (settings.notifyLargeTrade) {
      try {
        const fills = await hlPost({ type: 'userFillsByTime', user: addr, startTime: st.lastFillTime, aggregateByTime: false });
        let maxTime = st.lastFillTime;
        for (const f of (fills || [])) {
          const notional = Math.abs(parseFloat(f.sz)) * parseFloat(f.px);
          if (f.time > maxTime) maxTime = f.time;
          // Skip spot trades: spot coins look like "@107" or "PURR/USDC", and spot dir is plain "Buy"/"Sell".
          const coinStr = String(f.coin || '');
          const isSpot = coinStr.startsWith('@') || coinStr.includes('/') || f.dir === 'Buy' || f.dir === 'Sell';
          if (isSpot) continue;
          if (notional >= settings.largeTradeUsd) {
            await alert(settings, `💰 [${w.nickname}] Trade: ${f.dir || (f.side === 'B' ? 'Buy' : 'Sell')} ${f.coin} ${f.sz} @ ${fmtUsd(f.px)} (${fmtUsd(notional)})`);
          }
        }
        st.lastFillTime = maxTime;
      } catch (e) { /* non-fatal */ }
    }

    if (settings.notifyDepositWithdraw) {
      try {
        const startTime = st.lastLedgerTime || (Date.now() - settings.pollInterval * 1000);
        const events = await hlPost({ type: 'userNonFundingLedgerUpdates', user: addr, startTime });
        let maxTime = startTime;
        for (const ev of (events || [])) {
          if (ev.time > maxTime) maxTime = ev.time;
          const d = ev.delta || {};
          if (d.type === 'deposit') {
            await alert(settings, `📥 [${w.nickname}] Deposit: ${fmtUsd(d.usdc)}`);
          } else if (d.type === 'withdraw') {
            await alert(settings, `📤 [${w.nickname}] Withdrawal: ${fmtUsd(Math.abs(parseFloat(d.usdc)))}`);
          }
        }
        st.lastLedgerTime = maxTime;
      } catch (e) { /* non-fatal */ }
    }

    st.positions = newPositions;
    st.accountValue = accountValue;
    st._status = 'ok';
  } catch (e) {
    st._status = 'err';
    log(`[${label0}] check failed: ${e.message}`);
  }
}

// Config comes from environment variables when present (GitHub Actions secrets),
// otherwise from config.json. It is re-read every cycle in continuous mode.
function loadConfig() {
  const fileCfg = loadJSON(CONFIG_PATH, { wallets: [], settings: {} });
  const envWallets = parseEnvJSON('HL_WALLETS');
  const envSettings = parseEnvJSON('HL_SETTINGS') || {};

  const wallets = Array.isArray(envWallets) ? envWallets : (fileCfg.wallets || []);
  const settings = Object.assign({}, DEFAULT_SETTINGS, fileCfg.settings || {}, envSettings);
  if (process.env.TG_TOKEN) settings.tgToken = process.env.TG_TOKEN.trim();
  if (process.env.TG_CHAT_ID) settings.tgChatId = process.env.TG_CHAT_ID.trim();
  if (ONCE) settings.pollInterval = 300; // GitHub schedule is every ~5 minutes
  return { wallets, settings };
}

async function pollAll() {
  const { wallets, settings } = loadConfig();

  if (wallets.length === 0) {
    log('No wallets configured (set the HL_WALLETS secret, or add wallets to config.json).');
  }

  let i = 0;
  for (const w of wallets) {
    i++;
    w._label = QUIET ? `wallet ${i}` : w.nickname;
    await checkWallet(w, settings);
  }
  saveJSON(STATE_PATH, state);
  return Math.max(15, settings.pollInterval || 30);
}

async function main() {
  if (ONCE) {
    log('Running a single check...');
    try { await pollAll(); } catch (e) { log('Check error: ' + e.message); }
    log('Done.');
    return;
  }
  log('Hyperliquid tracker service starting...');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let interval = 30;
    try {
      interval = await pollAll();
    } catch (e) {
      log('Poll cycle error: ' + e.message);
    }
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}

main();
