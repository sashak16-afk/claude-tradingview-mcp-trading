/**
 * Debrief — sends a market summary + portfolio snapshot to Telegram
 * Runs via Railway cron at 7am and 5pm AEST (set per-service in dashboard)
 *
 * Covers:
 *   - Open positions: quantity, AUD value, P&L vs entry
 *   - Market snapshot: price, RSI14, Supertrend per symbol
 *   - Layer 1 gate status (tells you if bot CAN trade this session)
 */

import "dotenv/config";
import crypto from "crypto";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SYMBOLS = (process.env.SYMBOLS || "XBTAUD,ETHAUD,SOLAUD,XRPAUD,XDGAUD,LINKAUD,SEIUSD,NEARUSD")
  .split(",").map(s => s.trim()).filter(Boolean);

const BINANCE_MAP = {
  XBTAUD:  "BTCUSDT",  ETHAUD:  "ETHUSDT",  SOLAUD:  "SOLUSDT",
  XRPAUD:  "XRPUSDT",  XDGAUD:  "DOGEUSDT", LINKAUD: "LINKUSDT",
  SEIUSD:  "SEIUSDT",  NEARUSD: "NEARUSDT",
};

// Kraken asset codes for balance lookup
const KRAKEN_BASE = {
  XBTAUD: "XXBT", ETHAUD: "XETH",  SOLAUD:  "SOL",
  XRPAUD: "XXRP", XDGAUD: "XXDG", LINKAUD: "LINK",
  SEIUSD: "SEI",  NEARUSD: "NEAR",
};

// Short string to match pairs in TradesHistory
const KRAKEN_PAIR_PATTERN = {
  XBTAUD: "XBT", ETHAUD: "ETH",  SOLAUD:  "SOL",
  XRPAUD: "XRP", XDGAUD: "XDG", LINKAUD: "LINK",
  SEIUSD: "SEI", NEARUSD: "NEAR",
};

// ─── Market Data (Binance) ────────────────────────────────────────────────────

async function fetchCandles(symbol, limit = 300) {
  let res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`);
  if (!res.ok && res.status === 400)
    res = await fetch(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  return (await res.json()).map(k => ({
    time: k[0], high: parseFloat(k[2]), low: parseFloat(k[3]),
    close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ─── Kraken Private API ───────────────────────────────────────────────────────

function signKraken(path, nonce, postData) {
  const secret = Buffer.from(process.env.KRAKEN_API_SECRET, "base64");
  const hash   = crypto.createHash("sha256").update(nonce + postData).digest("binary");
  return crypto.createHmac("sha512", secret).update(path + hash, "binary").digest("base64");
}

async function krakenPrivate(path, params = {}) {
  const nonce    = Date.now().toString();
  const postData = new URLSearchParams({ nonce, ...params }).toString();
  const res = await fetch(`https://api.kraken.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "API-Key":  process.env.KRAKEN_API_KEY,
      "API-Sign": signKraken(path, nonce, postData),
    },
    body: postData,
  });
  const data = await res.json();
  if (data.error && data.error.length > 0) throw new Error(data.error.join(", "));
  return data.result;
}

async function fetchKrakenPrice(symbol) {
  const res  = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${symbol}`);
  const data = await res.json();
  if (data.error && data.error.length > 0) throw new Error(data.error.join(", "));
  return parseFloat(Object.values(data.result)[0].c[0]);
}

// ─── Portfolio (live Kraken balance + trade history) ─────────────────────────

async function fetchPortfolio() {
  if (!process.env.KRAKEN_API_KEY || !process.env.KRAKEN_API_SECRET) return { positions: [], audCash: 0 };

  try {
    const balances = await krakenPrivate("/0/private/Balance");
    const history  = await krakenPrivate("/0/private/TradesHistory");
    const trades = Object.values(history.trades || {});

    const audCash = parseFloat(balances["ZAUD"] || balances["AUD"] || "0");

    const positions = [];
    for (const symbol of SYMBOLS) {
      const base    = KRAKEN_BASE[symbol];
      const pattern = KRAKEN_PAIR_PATTERN[symbol];
      if (!base || !pattern) continue;

      const balance = parseFloat(balances[base] || "0");
      if (balance <= 0) continue;

      let currentPrice;
      try { currentPrice = await fetchKrakenPrice(symbol); }
      catch { continue; }

      const valueAUD = balance * currentPrice;
      if (valueAUD < 1.0) continue; // skip dust

      const lastBuy = trades
        .filter(t => t.type === "buy" && t.pair.toUpperCase().includes(pattern))
        .sort((a, b) => b.time - a.time)[0];

      const entryPrice = lastBuy ? parseFloat(lastBuy.price) : currentPrice;
      const costBasis  = entryPrice * balance;
      const pnl        = valueAUD - costBasis;
      const pnlPct     = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

      positions.push({ symbol, balance, currentPrice, valueAUD, entryPrice, pnl, pnlPct });
    }
    return { positions, audCash };
  } catch (err) {
    console.warn("Portfolio fetch failed:", err.message);
    return { positions: [], audCash: 0 };
  }
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * mult + ema * (1 - mult);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / avgLoss);
}

function calcVWAP(candles) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const session = candles.filter(c => c.time >= midnight.getTime());
  if (!session.length) return null;
  const tpv = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol  = session.reduce((s, c) => s + c.volume, 0);
  return vol === 0 ? null : tpv / vol;
}

function calcSupertrend(candles, period = 10, multiplier = 3.0) {
  if (candles.length < period + 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const atrS = [atr];
  for (let i = period; i < trs.length; i++) { atr = (atr * (period - 1) + trs[i]) / period; atrS.push(atr); }
  let trend = 1, fU = 0, fL = 0;
  for (let i = 0; i < atrS.length; i++) {
    const ci  = i + period;
    const hl2 = (candles[ci].high + candles[ci].low) / 2;
    const bU  = hl2 + multiplier * atrS[i];
    const bL  = hl2 - multiplier * atrS[i];
    const nU  = i === 0 ? bU : (candles[ci - 1].close < fU ? Math.min(bU, fU) : bU);
    const nL  = i === 0 ? bL : (candles[ci - 1].close > fL ? Math.max(bL, fL) : bL);
    const close = candles[ci].close;
    if (trend === -1 && close > nU) trend = 1;
    else if (trend === 1 && close < nL) trend = -1;
    fU = nU; fL = nL;
  }
  return { bullish: trend === 1 };
}

// ─── Per-symbol Market Analysis ───────────────────────────────────────────────

async function analyseSymbol(symbol) {
  try {
    const candles = await fetchCandles(BINANCE_MAP[symbol] || symbol);
    const closes  = candles.map(c => c.close);
    const price   = closes[closes.length - 1];
    const ema200  = calcEMA(closes, 200);
    const vwap    = calcVWAP(candles);
    const rsi14   = calcRSI(closes, 14);
    const st      = calcSupertrend(candles);

    const g1 = ema200 !== null && price > ema200;
    const g2 = vwap !== null && price > vwap;
    const g3 = rsi14 !== null && rsi14 > 52;
    const g4 = vwap ? Math.abs((price - vwap) / vwap) * 100 < 1.5 : false;
    const gatesPass = g1 && g2 && g3 && g4;

    return { symbol, price, ema200, vwap, rsi14, st, g1, g2, g3, g4, gatesPass, ok: true };
  } catch (err) {
    return { symbol, ok: false, error: err.message };
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmtAUD(n) {
  if (n === null || n === undefined) return "N/A";
  if (Math.abs(n) >= 1000) return "$" + n.toLocaleString("en-AU", { maximumFractionDigits: 0 });
  if (Math.abs(n) >= 1)    return "$" + n.toFixed(2);
  return "$" + n.toFixed(5);
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  const res  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${JSON.stringify(data)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runDebrief() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    process.exit(1);
  }

  console.log("Generating debrief...");

  const [results, portfolio] = await Promise.all([
    Promise.all(SYMBOLS.map(analyseSymbol)),
    fetchPortfolio(),
  ]);
  const { positions, audCash } = portfolio;

  const now     = new Date();
  const tz      = process.env.TZ || "Australia/Sydney";
  const dateStr = now.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz });
  const timeStr = now.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: tz, timeZoneName: "short" });

  const hour        = now.getUTCHours();
  const isMorning   = hour >= 19 || hour < 9; // 21:00 UTC = 7am AEST
  const label       = isMorning ? "🌅 Morning Debrief" : "🌆 Afternoon Debrief";
  const watching    = results.filter(r => r.ok && r.gatesPass);
  const blocked     = results.filter(r => r.ok && !r.gatesPass);

  let msg = `<b>${label}</b>\n`;
  msg    += `${dateStr} · ${timeStr}\n`;

  // ── Portfolio ──────────────────────────────────────────────────────────────
  msg += `\n──────────────────────────\n`;
  msg += `<b>📂 Open Positions</b>\n\n`;

  if (positions.length === 0) {
    msg += `<i>No open positions</i>\n`;
  } else {
    const totalValue = positions.reduce((s, p) => s + p.valueAUD, 0);
    const totalPnl   = positions.reduce((s, p) => s + p.pnl, 0);

    for (const p of positions) {
      const sign    = p.pnl >= 0 ? "+" : "";
      const emoji   = p.pnl >= 0 ? "🟢" : "🔴";
      const qty     = p.balance < 1 ? p.balance.toFixed(6) : p.balance.toFixed(2);
      msg += `${emoji} <b>${p.symbol}</b>\n`;
      msg += `   ${qty} units · now ${fmtAUD(p.currentPrice)}\n`;
      msg += `   Value: <b>${fmtAUD(p.valueAUD)} AUD</b>`;
      msg += `  ·  Entry: ${fmtAUD(p.entryPrice)}\n`;
      msg += `   P&amp;L: <b>${sign}${fmtAUD(p.pnl)} AUD</b>  (${sign}${p.pnlPct.toFixed(1)}%)\n\n`;
    }

    const totalSign  = totalPnl >= 0 ? "+" : "";
    const totalEmoji = totalPnl >= 0 ? "📈" : "📉";
    msg += `${totalEmoji} <b>Total: ${fmtAUD(totalValue)} AUD  ·  P&amp;L: ${totalSign}${fmtAUD(totalPnl)} AUD</b>\n`;
  }

  const portfolioTotal = positions.reduce((s, p) => s + p.valueAUD, 0) + audCash;
  msg += `\n💰 <b>Portfolio Total: ${fmtAUD(portfolioTotal)} AUD</b>`;
  msg += `  (${fmtAUD(audCash)} AUD cash`;
  if (positions.length > 0) {
    const cryptoValue = positions.reduce((s, p) => s + p.valueAUD, 0);
    msg += ` · ${fmtAUD(cryptoValue)} AUD in crypto`;
  }
  msg += `)\n`;

  // ── Market Snapshot ────────────────────────────────────────────────────────
  msg += `\n──────────────────────────\n`;
  msg += `<b>📊 Market Snapshot  (1H)</b>\n\n`;
  for (const r of results) {
    if (!r.ok) { msg += `• <b>${r.symbol}</b>  ⚠️ data unavailable\n`; continue; }
    const trend  = r.st ? (r.st.bullish ? "▲" : "▼") : "─";
    const rsiStr = r.rsi14 ? r.rsi14.toFixed(0) : "N/A";
    const gate   = r.gatesPass ? "👀" : "🚫";
    msg += `${gate} <b>${r.symbol}</b>  ${fmtAUD(r.price)}  RSI ${rsiStr} ${trend}\n`;
  }

  // ── Gate Detail ────────────────────────────────────────────────────────────
  msg += `\n──────────────────────────\n`;
  if (watching.length > 0) {
    msg += `<b>✅ Passing All Layer 1 Gates</b>\n`;
    msg += `<i>Bot will evaluate these for entry</i>\n\n`;
    for (const r of watching) {
      msg += `<b>${r.symbol}</b>  ${fmtAUD(r.price)}  RSI14: ${r.rsi14 ? r.rsi14.toFixed(0) : "N/A"}\n`;
      msg += `  EMA200 ✅  VWAP ✅  Regime ✅  Distance ✅\n\n`;
    }
  } else {
    msg += `<b>Layer 1 Gates — Nothing passing</b>\n`;
    msg += `<i>Bot will block all entries this session</i>\n\n`;
  }

  const topBlocked = blocked.filter(r => ["XBTAUD","ETHAUD","SOLAUD"].includes(r.symbol));
  if (topBlocked.length > 0) {
    msg += `<b>🔎 Why top coins are blocked:</b>\n`;
    for (const r of topBlocked) {
      const fails = [];
      if (!r.g1) fails.push("below EMA200");
      if (!r.g2) fails.push("below VWAP");
      if (!r.g3) fails.push(`RSI14 ${r.rsi14 ? r.rsi14.toFixed(0) : "N/A"} (need >52)`);
      if (!r.g4) fails.push(">1.5% from VWAP");
      msg += `• <b>${r.symbol}</b>: ${fails.join(", ")}\n`;
    }
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  msg += `\n──────────────────────────\n`;
  msg += `⚙️ <b>Bot</b>  🔴 LIVE · 1H · ${SYMBOLS.length} symbols · Kraken\n`;
  msg += `📋 Min confluence: 5/7 · Runs every hour`;

  await sendTelegram(msg);
  console.log("Debrief sent ✅");
}

// Run directly (e.g. node debrief.js) or triggered from bot.js at debrief hours
if (process.argv[1] && process.argv[1].includes("debrief")) {
  runDebrief().catch(err => {
    console.error("Debrief error:", err);
    process.exit(1);
  });
}
