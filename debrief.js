/**
 * Debrief — sends a market summary + portfolio snapshot to Telegram
 * Fires at 7am and 5pm AEST via Railway cron, or triggered from bot.js at those hours.
 *
 * Covers:
 *   - Open positions: quantity, AUD value, P&L vs entry
 *   - BTC macro regime status
 *   - Market snapshot: price, RSI14, Supertrend per symbol
 *   - Layer 1 gate status per symbol
 */

import "dotenv/config";
import crypto from "crypto";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SYMBOLS = (process.env.SYMBOLS || "XBTAUD,ETHAUD,SOLAUD,XRPAUD,XDGAUD,LINKAUD,ADAAUD,DOTUSD,UNIUSD,ATOMUSD")
  .split(",").map((s) => s.trim()).filter(Boolean);

const BINANCE_MAP = {
  XBTAUD:  "BTCUSDT",  ETHAUD:  "ETHUSDT",  SOLAUD:  "SOLUSDT",
  XRPAUD:  "XRPUSDT",  XDGAUD:  "DOGEUSDT", LINKAUD: "LINKUSDT",
  ADAAUD:  "ADAUSDT",  DOTUSD:  "DOTUSDT",  UNIUSD:  "UNIUSDT",
  ATOMUSD: "ATOMUSDT",
};

const KRAKEN_BASE = {
  XBTAUD: "XXBT", ETHAUD: "XETH",  SOLAUD: "SOL",
  XRPAUD: "XXRP", XDGAUD: "XXDG", LINKAUD: "LINK",
  ADAAUD: "ADA",  DOTUSD: "DOT",  UNIUSD:  "UNI",  ATOMUSD: "ATOM",
};

const KRAKEN_PAIR_PATTERN = {
  XBTAUD: "XBT", ETHAUD: "ETH",  SOLAUD: "SOL",
  XRPAUD: "XRP", XDGAUD: "XDG", LINKAUD: "LINK",
  ADAAUD: "ADA", DOTUSD: "DOT",  UNIUSD: "UNI",  ATOMUSD: "ATOM",
};

// ─── Market Data ──────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval = "1h", limit = 250) {
  let res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok && res.status === 400)
    res = await fetch(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  return (await res.json()).map((k) => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
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
  if (data.error?.length > 0) throw new Error(data.error.join(", "));
  return data.result;
}

async function fetchKrakenPrice(symbol) {
  const res  = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${symbol}`);
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(data.error.join(", "));
  return parseFloat(Object.values(data.result)[0].c[0]);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * mult + ema * (1 - mult);
  return ema;
}

// Wilder's smoothing RSI — matches TradingView
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

// Session VWAP — requires ≥4 bars
function calcVWAP(candles) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const session = candles.filter((c) => c.time >= midnight.getTime());
  if (session.length < 4) return null;
  const tpv = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol  = session.reduce((s, c) => s + c.volume, 0);
  return vol === 0 ? null : tpv / vol;
}

function calcSupertrend(candles, period = 10, multiplier = 2.0) {
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
    const c   = candles[ci].close;
    if (trend === -1 && c > nU) trend = 1;
    else if (trend === 1 && c < nL) trend = -1;
    fU = nU; fL = nL;
  }
  return { bullish: trend === 1 };
}

// ─── Supabase — open positions from bot_positions table ──────────────────────

async function fetchSupabasePositions() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return [];
  try {
    const res  = await fetch(`${url}/rest/v1/bot_positions?is_open=eq.true&select=symbol,entry_price_aud,entry_time,quantity`, {
      headers: { "apikey": key, "Authorization": `Bearer ${key}` },
    });
    return await res.json();
  } catch {
    return [];
  }
}

// ─── Portfolio ────────────────────────────────────────────────────────────────

async function fetchPortfolio() {
  if (!process.env.KRAKEN_API_KEY || !process.env.KRAKEN_API_SECRET) return { positions: [], audCash: 0 };

  try {
    // Get bot-owned positions from Supabase (not raw Kraken balance)
    const [balances, supabasePositions] = await Promise.all([
      krakenPrivate("/0/private/Balance"),
      fetchSupabasePositions(),
    ]);

    const audCash   = parseFloat(balances["ZAUD"] || balances["AUD"] || "0");
    const positions = [];

    for (const pos of supabasePositions) {
      const symbol   = pos.symbol;
      const base     = KRAKEN_BASE[symbol];
      if (!base) continue;

      const balance = parseFloat(balances[base] || "0");
      if (balance <= 0) continue;

      let currentPrice;
      try { currentPrice = await fetchKrakenPrice(symbol); } catch { continue; }

      const valueAUD   = balance * currentPrice;
      if (valueAUD < 1.0) continue;

      const entryPrice = parseFloat(pos.entry_price_aud);
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

// ─── Per-symbol Analysis ──────────────────────────────────────────────────────

async function analyseSymbol(symbol) {
  try {
    const allCandles = await fetchCandles(BINANCE_MAP[symbol] || symbol);
    const candles    = allCandles.slice(0, -1); // closed bars only
    const closes     = candles.map((c) => c.close);
    const price      = closes[closes.length - 1];
    const ema200     = calcEMA(closes, 200);
    const vwap       = calcVWAP(candles);
    const rsi14      = calcRSI(closes, 14);
    const st         = calcSupertrend(candles);

    const g1 = ema200 !== null && price > ema200;
    const g2 = vwap === null ? true : Math.abs((price - vwap) / vwap) * 100 <= 1.5;
    const g3 = rsi14 !== null && rsi14 > 45;
    // ADX not checked in debrief (requires more candle history than we fetch here)
    const gatesPass = g1 && g2 && g3;

    return { symbol, price, ema200, vwap, rsi14, st, g1, g2, g3, gatesPass, ok: true };
  } catch (err) {
    return { symbol, ok: false, error: err.message };
  }
}

async function checkBtcRegime() {
  try {
    const allCandles = await fetchCandles("BTCUSDT", "1h", 250);
    const closes     = allCandles.slice(0, -1).map((c) => c.close);
    const ema200     = calcEMA(closes, 200);
    const price      = closes[closes.length - 1];
    return { bullish: ema200 !== null && price > ema200, price, ema200 };
  } catch {
    return { bullish: null };
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

export async function sendTelegram(text) {
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

  const [results, portfolio, btc] = await Promise.all([
    Promise.all(SYMBOLS.map(analyseSymbol)),
    fetchPortfolio(),
    checkBtcRegime(),
  ]);
  const { positions, audCash } = portfolio;

  const now     = new Date();
  const tz      = process.env.TZ || "Australia/Sydney";
  const dateStr = now.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz });
  const timeStr = now.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: tz, timeZoneName: "short" });

  const utcHour  = now.getUTCHours();
  const label    = (utcHour >= 19 || utcHour < 9) ? "🌅 Morning Debrief" : "🌆 Afternoon Debrief";
  const watching = results.filter((r) => r.ok && r.gatesPass);
  const blocked  = results.filter((r) => r.ok && !r.gatesPass);

  let msg = `<b>${label}</b>\n${dateStr} · ${timeStr}\n`;

  // ── BTC Regime ─────────────────────────────────────────────────────────────
  msg += `\n──────────────────────────\n`;
  if (btc.bullish === null) {
    msg += `<b>🟡 BTC Regime:</b> data unavailable\n`;
  } else if (btc.bullish) {
    msg += `<b>✅ BTC Regime: Bullish</b>  (${fmtAUD(btc.price)} > EMA200 ${fmtAUD(btc.ema200)})\n`;
    msg += `<i>New long entries permitted</i>\n`;
  } else {
    msg += `<b>🚫 BTC Regime: Bearish</b>  (${fmtAUD(btc.price)} &lt; EMA200 ${fmtAUD(btc.ema200)})\n`;
    msg += `<i>All new long entries blocked — exits still active</i>\n`;
  }

  // ── Portfolio ──────────────────────────────────────────────────────────────
  msg += `\n──────────────────────────\n`;
  msg += `<b>📂 Open Positions</b>\n\n`;

  if (positions.length === 0) {
    msg += `<i>No open positions</i>\n`;
  } else {
    const totalValue = positions.reduce((s, p) => s + p.valueAUD, 0);
    const totalPnl   = positions.reduce((s, p) => s + p.pnl, 0);

    for (const p of positions) {
      const sign  = p.pnl >= 0 ? "+" : "";
      const emoji = p.pnl >= 0 ? "🟢" : "🔴";
      const qty   = p.balance < 1 ? p.balance.toFixed(6) : p.balance.toFixed(2);
      msg += `${emoji} <b>${p.symbol}</b>\n`;
      msg += `   ${qty} units · now ${fmtAUD(p.currentPrice)}\n`;
      msg += `   Value: <b>${fmtAUD(p.valueAUD)} AUD</b>  ·  Entry: ${fmtAUD(p.entryPrice)}\n`;
      msg += `   P&amp;L: <b>${sign}${fmtAUD(p.pnl)} AUD</b>  (${sign}${p.pnlPct.toFixed(1)}%)\n\n`;
    }

    const sign  = totalPnl >= 0 ? "+" : "";
    const emoji = totalPnl >= 0 ? "📈" : "📉";
    msg += `${emoji} <b>Total: ${fmtAUD(positions.reduce((s, p) => s + p.valueAUD, 0))} AUD  ·  P&amp;L: ${sign}${fmtAUD(totalPnl)} AUD</b>\n`;
  }

  const portfolioTotal = positions.reduce((s, p) => s + p.valueAUD, 0) + audCash;
  msg += `\n💰 <b>Portfolio: ${fmtAUD(portfolioTotal)} AUD</b>`;
  msg += `  (${fmtAUD(audCash)} cash`;
  if (positions.length > 0) msg += ` · ${fmtAUD(positions.reduce((s, p) => s + p.valueAUD, 0))} in crypto`;
  msg += `)\n`;

  // ── Market Snapshot ────────────────────────────────────────────────────────
  msg += `\n──────────────────────────\n`;
  msg += `<b>📊 Market Snapshot  (1H, closed bars)</b>\n\n`;
  for (const r of results) {
    if (!r.ok) { msg += `• <b>${r.symbol}</b>  ⚠️ unavailable\n`; continue; }
    const trend  = r.st ? (r.st.bullish ? "▲" : "▼") : "─";
    const rsiStr = r.rsi14 ? r.rsi14.toFixed(0) : "N/A";
    const gate   = r.gatesPass ? "👀" : "🚫";
    msg += `${gate} <b>${r.symbol}</b>  ${fmtAUD(r.price)}  RSI ${rsiStr} ${trend}\n`;
  }

  // ── Gate Detail ────────────────────────────────────────────────────────────
  msg += `\n──────────────────────────\n`;
  if (watching.length > 0) {
    msg += `<b>✅ Passing Layer 1 Gates  (${watching.length}/${SYMBOLS.length})</b>\n`;
    msg += `<i>Bot will score these for entry</i>\n\n`;
    for (const r of watching) {
      msg += `<b>${r.symbol}</b>  ${fmtAUD(r.price)}  RSI: ${r.rsi14 ? r.rsi14.toFixed(0) : "N/A"}\n`;
    }
  } else {
    msg += `<b>Layer 1 Gates — nothing passing</b>\n`;
    msg += `<i>Bot will block all entries this session</i>\n\n`;
  }

  if (blocked.length > 0) {
    const top = blocked.filter((r) => ["XBTAUD", "ETHAUD", "SOLAUD"].includes(r.symbol));
    if (top.length > 0) {
      msg += `\n<b>🔎 Why top coins are blocked:</b>\n`;
      for (const r of top) {
        const fails = [];
        if (!r.g1) fails.push(`below EMA200`);
        if (!r.g2 && r.vwap) fails.push(`VWAP dist ${(Math.abs((r.price - r.vwap) / r.vwap) * 100).toFixed(1)}% (need ≤1.5%)`);
        if (!r.g3) fails.push(`RSI14 ${r.rsi14 ? r.rsi14.toFixed(0) : "N/A"} (need >45)`);
        msg += `• <b>${r.symbol}</b>: ${fails.join(", ")}\n`;
      }
    }
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  msg += `\n──────────────────────────\n`;
  msg += `⚙️ <b>Bot v5.0</b>  ${process.env.PAPER_TRADING !== "false" ? "📋 PAPER" : "🔴 LIVE"} · 1H · ${SYMBOLS.length} symbols · Kraken\n`;
  msg += `📋 Min confluence: 4/8 · VWAP ±1.5% · TP 3×ATR · BTC regime gate`;

  await sendTelegram(msg);
  console.log("Debrief sent ✅");
}

if (process.argv[1]?.includes("debrief")) {
  runDebrief().catch((err) => { console.error("Debrief error:", err); process.exit(1); });
}
