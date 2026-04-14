/**
 * Morning Debrief — sends a daily market summary to Telegram
 * Runs via Railway cron at 8:30am (configured per timezone in railway service)
 *
 * What it covers:
 *   - Market snapshot for all watched symbols (price, RSI14, trend)
 *   - Layer 1 gate status for each coin (tells you if bot CAN trade today)
 *   - Bot config reminder
 */

import "dotenv/config";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SYMBOLS = (process.env.SYMBOLS || "XBTAUD,ETHAUD,SOLAUD,XRPAUD,XDGAUD,LINKAUD,SEIUSD,NEARUSD")
  .split(",").map(s => s.trim()).filter(Boolean);

const BINANCE_MAP = {
  XBTAUD:  "BTCUSDT",  ETHAUD:  "ETHUSDT",  SOLAUD:  "SOLUSDT",
  XRPAUD:  "XRPUSDT",  XDGAUD:  "DOGEUSDT", LINKAUD: "LINKUSDT",
  SEIUSD:  "SEIUSDT",  NEARUSD: "NEARUSDT",
  XBTUSDT: "BTCUSDT",  XDGUSDT: "DOGEUSDT",
};

// ─── Market Data ─────────────────────────────────────────────────────────────

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
  const vol = session.reduce((s, c) => s + c.volume, 0);
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

// ─── Per-symbol Analysis ──────────────────────────────────────────────────────

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

function fmtPrice(n) {
  if (n === null || n === undefined) return "N/A";
  if (n >= 10000) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1000)  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1)     return "$" + n.toFixed(3);
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

async function run() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    process.exit(1);
  }

  console.log("Generating morning debrief...");
  const results = await Promise.all(SYMBOLS.map(analyseSymbol));

  const now     = new Date();
  const tz      = process.env.TZ || "Australia/Sydney";
  const dateStr = now.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz });
  const timeStr = now.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: tz, timeZoneName: "short" });

  const watching = results.filter(r => r.ok && r.gatesPass);
  const blocked  = results.filter(r => r.ok && !r.gatesPass);

  const hour = now.getUTCHours();
  const isMorning = hour >= 20 || hour < 10; // 8:30am AEST = 22:30 UTC
  const debriefLabel = isMorning ? "🌅 Morning Debrief" : "🌆 Afternoon Debrief";

  let msg = `<b>${debriefLabel}</b>\n`;
  msg    += `${dateStr} · ${timeStr}\n`;
  msg    += `──────────────────────────\n\n`;

  // Market snapshot table
  msg += `<b>📊 Market Snapshot  (1H)</b>\n\n`;
  for (const r of results) {
    if (!r.ok) {
      msg += `• <b>${r.symbol}</b>  ⚠️ data unavailable\n`;
      continue;
    }
    const trend   = r.st ? (r.st.bullish ? "▲" : "▼") : "─";
    const rsiStr  = r.rsi14 ? r.rsi14.toFixed(0) : "N/A";
    const gate    = r.gatesPass ? "👀" : "🚫";
    msg += `${gate} <b>${r.symbol}</b>  ${fmtPrice(r.price)}  RSI ${rsiStr} ${trend}\n`;
  }

  // Layer 1 detail
  msg += `\n──────────────────────────\n`;
  if (watching.length > 0) {
    msg += `\n<b>✅ Coins Passing All Layer 1 Gates</b>\n`;
    msg += `<i>Bot will evaluate these for entry this session</i>\n\n`;
    for (const r of watching) {
      const rsiStr = r.rsi14 ? r.rsi14.toFixed(0) : "N/A";
      msg += `<b>${r.symbol}</b>  ${fmtPrice(r.price)}  RSI14: ${rsiStr}\n`;
      msg += `  EMA200 ✅  VWAP ✅  Regime ✅  Distance ✅\n\n`;
    }
  } else {
    msg += `\n<b>Layer 1 Gates — Nothing passing right now</b>\n`;
    msg += `<i>Bot will block all entries this session</i>\n\n`;
  }

  // Failed gates detail for top coins
  const topBlocked = blocked.filter(r => ["XBTAUD","ETHAUD","SOLAUD"].includes(r.symbol));
  if (topBlocked.length > 0) {
    msg += `<b>🔎 Why top coins are blocked:</b>\n`;
    for (const r of topBlocked) {
      const fails = [];
      if (!r.g1) fails.push(`below EMA200`);
      if (!r.g2) fails.push(`below VWAP`);
      if (!r.g3) fails.push(`RSI14 ${r.rsi14 ? r.rsi14.toFixed(0) : "N/A"} (need >52)`);
      if (!r.g4) fails.push(`>1.5% from VWAP`);
      msg += `• <b>${r.symbol}</b>: ${fails.join(", ")}\n`;
    }
  }

  // Footer
  msg += `\n──────────────────────────\n`;
  msg += `⚙️ <b>Bot</b>  🔴 LIVE · 1H · ${SYMBOLS.length} symbols · Kraken\n`;
  msg += `📋 Min confluence: 5/7 · Runs every hour`;

  await sendTelegram(msg);
  console.log("Debrief sent ✅");
}

run().catch(err => {
  console.error("Debrief error:", err);
  process.exit(1);
});
