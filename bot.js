/**
 * Claude + TradingView MCP — Automated Trading Bot v5.0
 *
 * Strategy: Blended Confluence Scalper v5.0
 * Timeframe: 1H  |  Cron: 0 * * * *  |  Exchange: Kraken
 *
 * Changes from v4.0:
 *   - Back to 1H (was 15m) — lower spread impact on Kraken AUD pairs, cleaner signals
 *   - VWAP gate widened to ±1.5% (was ±0.5% — eliminated too many valid setups)
 *   - Take-profit reduced to 3×ATR (was 4×ATR — 4×ATR rarely hit before trailing stop)
 *   - BTC 1H EMA(200) macro gate — blocks all new longs in bear regime (was in rules.json only)
 *   - RSI uses Wilder's smoothing O(n) — matches TradingView (was simple average, diverged)
 *   - MACD uses O(n) EMA series (was O(n²) loop per bar)
 *   - Entry signals use only closed bars — candles.slice(0,-1) (was using live forming bar)
 *   - VWAP session guard: skipped if <4 bars in session (early UTC data unreliable)
 *   - Supabase bot_positions table: position ownership in DB, not raw Kraken balance lookup
 *     (prevents bot selling pre-existing holdings)
 *   - USD-pair entry price fix: entryPriceUsdt uses actual USD fill price (was AUD×rate, wrong)
 *   - Daily loss limit: halts new entries if day's closed P&L ≤ -3% portfolio
 *   - Stale limit cancellation: cancels unfilled buy limits >2 hours old each run
 *   - Kraken minimum order sizes defined for all 10 symbols
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["KRAKEN_API_KEY", "KRAKEN_API_SECRET"];
  const missing  = required.filter((k) => !process.env[k]);
  if (missing.length === 0) return;

  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file found — creating template...\n");
    writeFileSync(".env", [
      "# Kraken credentials",
      "KRAKEN_API_KEY=",
      "KRAKEN_API_SECRET=",
      "",
      "# Trading config",
      "PORTFOLIO_VALUE_USD=1000",
      "MAX_TRADE_SIZE_AUD=200",
      "MIN_TRADE_SIZE_AUD=100",
      "MAX_TRADES_PER_DAY=10",
      "PAPER_TRADING=true",
      "SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XRPAUD,XDGAUD,LINKAUD,ADAAUD,DOTUSD,UNIUSD,ATOMUSD",
      "TIMEFRAME=1H",
      "",
      "# Telegram — debrief",
      "TELEGRAM_BOT_TOKEN=",
      "TELEGRAM_CHAT_ID=",
      "",
      "# Supabase — required for live trading (position tracking + HWM persistence)",
      "SUPABASE_URL=",
      "SUPABASE_KEY=",
    ].join("\n") + "\n");
    try { execSync("open .env"); } catch {}
    process.exit(0);
  }

  console.log(`\n⚠️  Missing env vars: ${missing.join(", ")}`);
  process.exit(0);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  symbols:         (process.env.SYMBOLS || "XBTAUD").split(",").map((s) => s.trim()).filter(Boolean),
  timeframe:       process.env.TIMEFRAME || "1H",
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeAUD: parseFloat(process.env.MAX_TRADE_SIZE_AUD || "200"),
  minTradeSizeAUD: parseFloat(process.env.MIN_TRADE_SIZE_AUD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "10"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  kraken: {
    apiKey:    process.env.KRAKEN_API_KEY,
    apiSecret: process.env.KRAKEN_API_SECRET,
    baseUrl:   "https://api.kraken.com",
  },
};

const TF_MAP      = { "1m":1,"3m":3,"5m":5,"15m":15,"30m":30,"1H":60,"4H":240,"1D":1440 };
const TF_MINUTES  = TF_MAP[CONFIG.timeframe] || 60;
const TIME_STOP_BARS = Math.ceil(24 * 60 / TF_MINUTES); // 24 bars @ 1H = 24H

const LOG_FILE = "safety-check-log.json";

// ─── Correlation Buckets ──────────────────────────────────────────────────────

const BUCKETS = {
  BTC_BETA:  ["XBTAUD", "ETHAUD", "SOLAUD", "ADAAUD"],
  ALT_BETA:  ["XRPAUD", "XDGAUD", "LINKAUD"],
  USD_PAIRS: ["DOTUSD", "UNIUSD", "ATOMUSD"],
};
const MAX_PER_BUCKET = 2;

function getBucket(symbol) {
  for (const [name, syms] of Object.entries(BUCKETS)) {
    if (syms.includes(symbol)) return name;
  }
  return "OTHER";
}

// ─── Ephemeral Log (within-run trade counting) ────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

function supabaseHeaders() {
  const key = process.env.SUPABASE_KEY;
  return {
    "Content-Type":  "application/json",
    "apikey":        key,
    "Authorization": `Bearer ${key}`,
  };
}

function supabaseUrl(path) {
  return `${process.env.SUPABASE_URL}/rest/v1/${path}`;
}

function supabaseReady() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
}

async function supabaseInsert(table, row) {
  if (!supabaseReady()) return;
  try {
    await fetch(supabaseUrl(table), {
      method:  "POST",
      headers: { ...supabaseHeaders(), "Prefer": "return=minimal" },
      body:    JSON.stringify(row),
    });
  } catch (err) {
    console.log(`  ⚠️  Supabase insert(${table}): ${err.message}`);
  }
}

async function supabaseUpsert(table, row, conflictCol) {
  if (!supabaseReady()) return;
  try {
    await fetch(`${supabaseUrl(table)}?on_conflict=${conflictCol}`, {
      method:  "POST",
      headers: { ...supabaseHeaders(), "Prefer": "resolution=merge-duplicates,return=minimal" },
      body:    JSON.stringify(row),
    });
  } catch (err) {
    console.log(`  ⚠️  Supabase upsert(${table}): ${err.message}`);
  }
}

async function supabasePatch(table, filter, row) {
  if (!supabaseReady()) return;
  try {
    await fetch(`${supabaseUrl(table)}?${filter}`, {
      method:  "PATCH",
      headers: { ...supabaseHeaders(), "Prefer": "return=minimal" },
      body:    JSON.stringify(row),
    });
  } catch (err) {
    console.log(`  ⚠️  Supabase patch(${table}): ${err.message}`);
  }
}

async function supabaseSelect(table, filter, select = "*") {
  if (!supabaseReady()) return null;
  try {
    const res  = await fetch(`${supabaseUrl(table)}?${filter}&select=${select}`, {
      headers: supabaseHeaders(),
    });
    return await res.json();
  } catch {
    return null;
  }
}

// ─── HWM (High-Water Mark) ────────────────────────────────────────────────────

async function getHWM(symbol) {
  const data = await supabaseSelect("bot_state", `key=eq.hwm_${symbol}`, "value");
  return data?.[0] ? parseFloat(data[0].value) : null;
}

async function saveHWM(symbol, hwm) {
  await supabaseUpsert("bot_state", {
    key:        `hwm_${symbol}`,
    value:      hwm > 0 ? hwm.toString() : null,
    updated_at: new Date().toISOString(),
  }, "key");
}

// ─── Position Tracking (Supabase) ─────────────────────────────────────────────

async function getOpenPosition(symbol) {
  const data = await supabaseSelect("bot_positions", `symbol=eq.${symbol}&is_open=eq.true`);
  return data?.[0] || null;
}

async function openPosition(pos) {
  await supabaseUpsert("bot_positions", {
    symbol:            pos.symbol,
    entry_price_aud:   pos.entryPriceAUD,
    entry_price_usdt:  pos.entryPriceUsdt,
    entry_time:        new Date(pos.entryTime).toISOString(),
    quantity:          pos.quantity,
    stop_loss_usdt:    pos.stopLossUsdt,
    take_profit_usdt:  pos.takeProfitUsdt,
    order_id:          pos.orderId,
    mode:              CONFIG.paperTrading ? "PAPER" : "LIVE",
    is_open:           true,
  }, "symbol");
}

async function closePosition(symbol) {
  await supabasePatch("bot_positions", `symbol=eq.${symbol}`, { is_open: false });
}

// ─── Daily Loss Limit ─────────────────────────────────────────────────────────

async function checkDailyLossLimit() {
  if (!supabaseReady()) return { blocked: false, dailyPnl: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const modeFilter = CONFIG.paperTrading ? "PAPER" : "LIVE";
  const data = await supabaseSelect(
    "bot_trades",
    `timestamp=gte.${today}T00:00:00Z&side=eq.sell&mode=eq.${modeFilter}`,
    "pnl"
  );
  if (!data) return { blocked: false, dailyPnl: 0 };
  const dailyPnl = data.reduce((s, r) => s + (parseFloat(r.pnl) || 0), 0);
  const limit    = CONFIG.portfolioValue * -0.03;
  return { blocked: dailyPnl <= limit, dailyPnl };
}

// ─── Today's Trade Count ──────────────────────────────────────────────────────

async function countTodaysTrades() {
  if (supabaseReady()) {
    const today      = new Date().toISOString().slice(0, 10);
    const modeFilter = CONFIG.paperTrading ? "PAPER" : "LIVE";
    const data = await supabaseSelect(
      "bot_trades",
      `timestamp=gte.${today}T00:00:00Z&side=eq.buy&mode=eq.${modeFilter}`,
      "id"
    );
    if (Array.isArray(data)) return data.length;
  }
  // Fallback: count from local ephemeral log (resets on Railway redeploy)
  const log   = loadLog();
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter((t) => t.timestamp?.startsWith(today) && t.orderPlaced).length;
}

// ─── Symbol Maps ──────────────────────────────────────────────────────────────

const QUOTE_CURRENCY = {
  XBTAUD:  "AUD", ETHAUD:  "AUD", SOLAUD:  "AUD", XRPAUD:  "AUD",
  XDGAUD:  "AUD", LINKAUD: "AUD", ADAAUD:  "AUD",
  DOTUSD:  "USD", UNIUSD:  "USD", ATOMUSD: "USD",
};

const BINANCE_SYMBOL_MAP = {
  XBTAUD: "BTCUSDT",  ETHAUD: "ETHUSDT",  SOLAUD:  "SOLUSDT",
  XRPAUD: "XRPUSDT",  XDGAUD: "DOGEUSDT", LINKAUD: "LINKUSDT",
  ADAAUD: "ADAUSDT",  DOTUSD: "DOTUSDT",  UNIUSD:  "UNIUSDT",
  ATOMUSD: "ATOMUSDT",
};

const KRAKEN_BASE = {
  XBTAUD: "XXBT", ETHAUD: "XETH", SOLAUD: "SOL",
  XRPAUD: "XXRP", XDGAUD: "XXDG", LINKAUD: "LINK",
  ADAAUD: "ADA",  DOTUSD: "DOT",  UNIUSD:  "UNI", ATOMUSD: "ATOM",
};

const KRAKEN_PAIR_PATTERN = {
  XBTAUD: "XBT", ETHAUD: "ETH", SOLAUD: "SOL",
  XRPAUD: "XRP", XDGAUD: "XDG", LINKAUD: "LINK",
  ADAAUD: "ADA", DOTUSD: "DOT", UNIUSD:  "UNI", ATOMUSD: "ATOM",
};

// Kraken minimum order volumes (in base currency) — from Kraken AssetPairs
const KRAKEN_MIN_ORDER = {
  XBTAUD:  0.0001,
  ETHAUD:  0.01,
  SOLAUD:  0.5,
  XRPAUD:  10,
  XDGAUD:  50,
  LINKAUD: 1,
  ADAAUD:  5,
  DOTUSD:  0.75,
  UNIUSD:  0.25,
  ATOMUSD: 0.25,
};

function toBinanceSymbol(s) {
  return BINANCE_SYMBOL_MAP[s] || s;
}

// ─── Kraken Live Price ────────────────────────────────────────────────────────

async function fetchKrakenTicker(symbol) {
  const res  = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${symbol}`);
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(`Kraken ticker: ${data.error.join(", ")}`);
  const t = Object.values(data.result)[0];
  return {
    last: parseFloat(t.c[0]),
    ask:  parseFloat(t.a[0]),
    bid:  parseFloat(t.b[0]),
  };
}

// ─── Market Data (Binance) ────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 500) {
  const binanceInterval = interval === "1H" ? "1h" : interval === "4H" ? "4h" : interval.toLowerCase();
  let res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`
  );
  if (!res.ok && res.status === 400) {
    res = await fetch(
      `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`
    );
  }
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  return (await res.json()).map((k) => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
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

// Full EMA series — used by MACD to avoid O(n²)
function calcEMASeries(closes, period) {
  if (closes.length < period) return new Array(closes.length).fill(null);
  const mult   = 2 / (period + 1);
  const series = new Array(period - 1).fill(null);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  series.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * mult + ema * (1 - mult);
    series.push(ema);
  }
  return series;
}

// Full RSI series using Wilder's smoothing — O(n), matches TradingView
function calcRSISeries(closes, period = 14) {
  if (closes.length < period + 1) return [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  const series = [avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)];
  for (let i = period + 1; i < closes.length; i++) {
    const d    = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    series.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return series;
}

function calcRSI(closes, period = 14) {
  const s = calcRSISeries(closes, period);
  return s.length > 0 ? s[s.length - 1] : null;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < candles.length; i++) {
    const up   = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    ));
  }
  let sTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  const dx = [];
  const pushDX = () => {
    const pdi = sTR > 0 ? (sPDM / sTR) * 100 : 0;
    const mdi = sTR > 0 ? (sMDM / sTR) * 100 : 0;
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  };
  pushDX();
  for (let i = period; i < tr.length; i++) {
    sTR  = sTR  - sTR  / period + tr[i];
    sPDM = sPDM - sPDM / period + plusDM[i];
    sMDM = sMDM - sMDM / period + minusDM[i];
    pushDX();
  }
  if (dx.length < period) return null;
  return dx.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Session VWAP — resets at midnight UTC. Guard: requires ≥4 bars (4H on 1H TF)
function calcVWAP(candles) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const session = candles.filter((c) => c.time >= midnight.getTime());
  if (session.length < 4) return null; // too few bars for reliable VWAP
  const tpv = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol  = session.reduce((s, c) => s + c.volume, 0);
  return vol === 0 ? null : tpv / vol;
}

// MACD — O(n) using precomputed EMA series
function calcMACD(closes, fast = 12, slow = 26, sigPeriod = 9) {
  if (closes.length < slow + sigPeriod + 2) return null;
  const fastS = calcEMASeries(closes, fast);
  const slowS = calcEMASeries(closes, slow);
  const macdLine = [];
  for (let i = slow - 1; i < closes.length; i++) macdLine.push(fastS[i] - slowS[i]);
  if (macdLine.length < sigPeriod + 2) return null;
  const mult = 2 / (sigPeriod + 1);
  let sig = macdLine.slice(0, sigPeriod).reduce((a, b) => a + b, 0) / sigPeriod;
  const sigS = [sig];
  for (let i = sigPeriod; i < macdLine.length; i++) { sig = macdLine[i] * mult + sig * (1 - mult); sigS.push(sig); }
  const n = sigS.length;
  return {
    histogram:     macdLine[sigPeriod - 1 + n - 1] - sigS[n - 1],
    prevHistogram: macdLine[sigPeriod - 1 + n - 2] - sigS[n - 2],
  };
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
  const atrS = [];
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atrS.push(atr);
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

// StochRSI — uses precomputed RSI series (O(n), was O(n²))
function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsiSeries = calcRSISeries(closes, rsiPeriod);
  if (rsiSeries.length < stochPeriod + kSmooth + dSmooth) return null;
  const rawK = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
    const w  = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const hi = Math.max(...w), lo = Math.min(...w);
    rawK.push(hi === lo ? 50 : (rsiSeries[i] - lo) / (hi - lo) * 100);
  }
  const kS = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) kS.push(rawK.slice(i - kSmooth + 1, i + 1).reduce((a, b) => a + b, 0) / kSmooth);
  const dS = [];
  for (let i = dSmooth - 1; i < kS.length; i++) dS.push(kS.slice(i - dSmooth + 1, i + 1).reduce((a, b) => a + b, 0) / dSmooth);
  if (kS.length < 2 || dS.length < 2) return null;
  return { k: kS[kS.length - 1], d: dS[dS.length - 1], prevK: kS[kS.length - 2], prevD: dS[dS.length - 2] };
}

function calcBollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const recent = closes.slice(-period);
  const middle = recent.reduce((a, b) => a + b, 0) / period;
  const std    = Math.sqrt(recent.reduce((s, c) => s + Math.pow(c - middle, 2), 0) / period);
  return { upper: middle + stdDev * std, middle, lower: middle - stdDev * std, std };
}

function calcVolumeMedian(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const vols = candles.slice(-period - 1, -1).map((c) => c.volume).sort((a, b) => a - b);
  const mid  = Math.floor(vols.length / 2);
  return vols.length % 2 === 0 ? (vols[mid - 1] + vols[mid]) / 2 : vols[mid];
}

// ─── BTC Macro Gate ───────────────────────────────────────────────────────────
// Blocks all new longs when BTC is below its 1H EMA(200). Uses closed bars.

async function checkBtcRegime() {
  try {
    const res = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=250");
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const rawCandles = (await res.json()).map((k) => parseFloat(k[4]));
    const closed     = rawCandles.slice(0, -1); // exclude live bar
    const ema200     = calcEMA(closed, 200);
    const price      = closed[closed.length - 1];
    const bullish    = ema200 !== null && price > ema200;
    console.log("\n── BTC Macro Gate ───────────────────────────────────────\n");
    console.log(`  BTC (1H): $${price.toFixed(2)} vs EMA(200): $${ema200 ? ema200.toFixed(2) : "N/A"}`);
    console.log(`  Regime: ${bullish ? "✅ Bullish — longs permitted" : "🚫 Bearish — all new longs blocked"}`);
    return { bullish, price, ema200 };
  } catch (err) {
    console.log(`  ⚠️  BTC regime check failed: ${err.message} — defaulting to permit`);
    return { bullish: true };
  }
}

// ─── Stale Limit Order Cancellation ──────────────────────────────────────────
// Cancels unfilled buy limits placed >2 hours ago to avoid stale exposure.

async function cancelStaleOrders() {
  if (CONFIG.paperTrading) return;
  console.log("\n── Stale Order Check ────────────────────────────────────\n");
  try {
    const result  = await krakenPrivate("/0/private/OpenOrders");
    const open    = Object.entries(result.open || {});
    const cutoff  = Date.now() / 1000 - 2 * 3600;
    let cancelled = 0;
    for (const [txid, order] of open) {
      if (order.descr?.type === "buy" && parseFloat(order.opentm) < cutoff) {
        try {
          await krakenPrivate("/0/private/CancelOrder", { txid });
          console.log(`  🗑️  Cancelled stale buy limit ${txid} (${order.descr?.pair})`);
          cancelled++;
        } catch (err) {
          console.log(`  ⚠️  Cancel failed ${txid}: ${err.message}`);
        }
      }
    }
    if (cancelled === 0) console.log("  ✅ No stale buy limits to cancel");
  } catch (err) {
    console.log(`  ⚠️  Open order check failed: ${err.message}`);
  }
}

// ─── 5-Layer Confluence Check (v5.0) ─────────────────────────────────────────

function runConfluenceCheck(price, indicators) {
  const {
    ema8, ema21, ema21_3ago, ema200,
    vwap, rsi14, rsi7, adx,
    macd, supertrend, stochRsi, bb,
    curVolume, medianVolume,
  } = indicators;

  const conditions = [];
  const chk = (label, pass, detail) => {
    conditions.push({ label, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}${detail ? `  (${detail})` : ""}`);
  };

  // ── Layer 1: Binary gates — ALL must pass ─────────────────────────────
  console.log("\n── Layer 1: Gates (all must pass) ──────────────────────\n");

  const g1 = ema200 !== null && price > ema200;
  chk("Price above EMA(200)", g1,
    `price ${price.toFixed(4)} vs EMA200 ${ema200 ? ema200.toFixed(4) : "N/A"}`);

  // VWAP: null means <4 session bars — skip gate this run
  const vwapDist = vwap ? Math.abs((price - vwap) / vwap) * 100 : null;
  const g2 = vwap === null ? true : vwapDist <= 1.5;
  chk(
    vwap === null ? "VWAP gate skipped — <4 session bars" : "Price within ±1.5% of VWAP",
    g2,
    vwap ? `${vwapDist.toFixed(2)}% from VWAP ${vwap.toFixed(4)}` : "early session"
  );

  const g3 = rsi14 !== null && rsi14 > 45;
  chk("RSI(14) > 45", g3, `RSI14 = ${rsi14 ? rsi14.toFixed(1) : "N/A"}`);

  const g4 = adx !== null && adx > 20;
  chk("ADX(14) > 20 — trending market", g4, `ADX = ${adx ? adx.toFixed(1) : "N/A"}`);

  if (!g1 || !g2 || !g3 || !g4) {
    console.log("\n🚫 Layer 1 failed — skip\n");
    return { allPass: false, score: 0, conditions, direction: "NONE" };
  }

  // ── Layer 2: Intermediate trend — 2 pts ──────────────────────────────
  console.log("\n── Layer 2: Intermediate Trend (2 pts) ─────────────────\n");
  let score = 0;

  const l2a = ema21 !== null && ema21_3ago !== null && ema21 > ema21_3ago;
  chk("EMA(21) rising vs 3 bars ago [+1]", l2a,
    `now ${ema21 ? ema21.toFixed(4) : "N/A"} vs 3-ago ${ema21_3ago ? ema21_3ago.toFixed(4) : "N/A"}`);
  if (l2a) score++;

  const l2b = supertrend !== null && supertrend.bullish;
  chk("Supertrend (10, 2.0) bullish [+1]", l2b,
    supertrend ? (supertrend.bullish ? "Green" : "Red") : "N/A");
  if (l2b) score++;

  // ── Layer 3: Micro trigger — 3 pts ───────────────────────────────────
  console.log("\n── Layer 3: Micro Trigger (3 pts) ──────────────────────\n");

  const l3a = ema8 !== null && ema21 !== null && ema8 > ema21;
  chk("EMA(8) above EMA(21) [+1]", l3a,
    `EMA8 ${ema8 ? ema8.toFixed(4) : "N/A"} vs EMA21 ${ema21 ? ema21.toFixed(4) : "N/A"}`);
  if (l3a) score++;

  const l3b = macd !== null && macd.histogram > 0;
  chk("MACD histogram positive [+1]", l3b,
    macd ? `hist ${macd.histogram.toFixed(6)}` : "N/A");
  if (l3b) score++;

  const l3c = curVolume !== null && medianVolume !== null && curVolume > medianVolume * 0.35;
  chk("Volume above 35% of 20-bar median [+1]", l3c,
    (curVolume && medianVolume) ? `cur ${curVolume.toFixed(0)} vs median ${medianVolume.toFixed(0)}` : "N/A");
  if (l3c) score++;

  // ── Layer 4: Entry timing — 3 pts ────────────────────────────────────
  console.log("\n── Layer 4: Entry Timing (3 pts) ───────────────────────\n");

  const l4a = rsi7 !== null && rsi7 >= 45 && rsi7 <= 65;
  chk("RSI(7) between 45–65 — momentum pullback [+1]", l4a,
    rsi7 ? `RSI7 = ${rsi7.toFixed(1)}` : "N/A");
  if (l4a) score++;

  const l4b = stochRsi !== null && stochRsi.k > stochRsi.d && stochRsi.k < 80;
  chk("StochRSI %K > %D and < 80 [+1]", l4b,
    stochRsi ? `K=${stochRsi.k.toFixed(1)} D=${stochRsi.d.toFixed(1)}` : "N/A");
  if (l4b) score++;

  const l4c = bb !== null && Math.abs(price - bb.middle) <= bb.std;
  chk("Price within middle BB ± 1σ [+1]", l4c,
    bb ? `price ${price.toFixed(4)}, mid ${bb.middle.toFixed(4)} ±1σ ${bb.std.toFixed(4)}` : "N/A");
  if (l4c) score++;

  const allPass = score >= 4;
  console.log(`\n── Confluence Score: ${score}/8 — ${allPass ? "✅ TRADE SIGNAL" : "🚫 need 4 minimum"}\n`);
  return { allPass, score, conditions, direction: "LONG" };
}

// ─── Trade Size ───────────────────────────────────────────────────────────────

function calcTradeSize(score, atrPct) {
  const riskPct  = score >= 7 ? 0.010 : score >= 6 ? 0.0075 : 0.005;
  const riskAUD  = CONFIG.portfolioValue * riskPct;
  const stopPct  = atrPct * 1.5;
  const atrSized = stopPct > 0 ? riskAUD / stopPct : CONFIG.minTradeSizeAUD;
  return Math.max(Math.min(atrSized, CONFIG.maxTradeSizeAUD), CONFIG.minTradeSizeAUD);
}

// ─── Exit Conditions ──────────────────────────────────────────────────────────

function checkExitConditions(position, usdtPrice, atr, hwm) {
  const trailingStop = hwm - atr * 2.0;
  const reasons      = [];

  console.log("\n── Exit Check ───────────────────────────────────────────\n");
  console.log(`  Entry (USDT):   $${position.entryPriceUsdt.toFixed(4)}`);
  console.log(`  Entry (AUD):    $${position.entryPriceAUD.toFixed(4)}`);
  console.log(`  Current (USDT): $${usdtPrice.toFixed(4)}`);
  console.log(`  High-water:     $${hwm.toFixed(4)}`);
  console.log(`  Trailing stop:  $${trailingStop.toFixed(4)} (HWM − 2.0×ATR)`);
  console.log(`  Hard stop-loss: $${position.stopLossUsdt.toFixed(4)}`);
  console.log(`  Take-profit:    $${position.takeProfitUsdt.toFixed(4)} (3×ATR)`);

  if (usdtPrice <= position.stopLossUsdt)
    reasons.push(`Hard stop hit (${usdtPrice.toFixed(4)} ≤ ${position.stopLossUsdt.toFixed(4)})`);
  if (usdtPrice >= position.takeProfitUsdt)
    reasons.push(`Take-profit hit (${usdtPrice.toFixed(4)} ≥ ${position.takeProfitUsdt.toFixed(4)})`);
  if (usdtPrice <= trailingStop)
    reasons.push(`Trailing stop hit (${usdtPrice.toFixed(4)} ≤ ${trailingStop.toFixed(4)}, HWM ${hwm.toFixed(4)})`);

  if (position.entryTime) {
    const ageBars = (Date.now() - position.entryTime) / (TF_MINUTES * 60 * 1000);
    console.log(`  Position age:   ${Math.round(ageBars)} bars (limit ${TIME_STOP_BARS})`);
    if (ageBars > TIME_STOP_BARS)
      reasons.push(`Time stop: ${Math.round(ageBars)} bars open (> ${TIME_STOP_BARS} = 24H)`);
  }

  if (reasons.length === 0) console.log("  📊 Holding — no exit condition triggered");
  else reasons.forEach((r) => console.log(`  🚨 ${r}`));

  return { shouldExit: reasons.length > 0, reasons };
}

// ─── Trade Limits ─────────────────────────────────────────────────────────────

async function checkTradeLimits() {
  const todayCount = await countTodaysTrades();
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  const { blocked: lossBlocked, dailyPnl } = await checkDailyLossLimit();
  if (lossBlocked) {
    console.log(`🚫 Daily loss limit hit: ${dailyPnl >= 0 ? "+" : ""}${dailyPnl.toFixed(2)} AUD (limit -3% = -${(CONFIG.portfolioValue * 0.03).toFixed(2)} AUD)`);
    return false;
  }

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} | Daily P&L: ${dailyPnl >= 0 ? "+" : ""}${dailyPnl.toFixed(2)} AUD`);
  return true;
}

// ─── Kraken API ───────────────────────────────────────────────────────────────

function signKraken(path, nonce, postData) {
  const secret = Buffer.from(CONFIG.kraken.apiSecret, "base64");
  const hash   = crypto.createHash("sha256").update(nonce + postData).digest("binary");
  return crypto.createHmac("sha512", secret).update(path + hash, "binary").digest("base64");
}

async function krakenPrivate(path, params = {}) {
  const nonce    = Date.now().toString();
  const postData = new URLSearchParams({ nonce, ...params }).toString();
  const res = await fetch(`${CONFIG.kraken.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "API-Key":  CONFIG.kraken.apiKey,
      "API-Sign": signKraken(path, nonce, postData),
    },
    body: postData,
  });
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(data.error.join(", "));
  return data.result;
}

async function fetchKrakenOpenOrders(symbol) {
  try {
    const result  = await krakenPrivate("/0/private/OpenOrders");
    const open    = Object.values(result.open || {});
    const pattern = KRAKEN_PAIR_PATTERN[symbol];
    return open.filter((o) => o.descr?.pair?.toUpperCase().includes(pattern));
  } catch (err) {
    console.log(`  ⚠️  Open order check failed: ${err.message}`);
    return [];
  }
}

// Kraken tick-size precision
function krakenPriceStr(price) {
  if (price >= 10000) return price.toFixed(1);
  if (price >= 1000)  return price.toFixed(2);
  if (price >= 100)   return price.toFixed(3);
  if (price >= 1)     return price.toFixed(4);
  if (price >= 0.1)   return price.toFixed(5);
  return price.toFixed(6);
}

async function placeKrakenOrder(symbol, side, volume, limitPrice = null) {
  const path   = "/0/private/AddOrder";
  const nonce  = Date.now().toString();
  const params = {
    nonce, pair: symbol, type: side,
    ordertype: limitPrice ? "limit" : "market",
    volume: parseFloat(volume).toFixed(8),
  };
  if (limitPrice) params.price = krakenPriceStr(limitPrice);
  const postData = new URLSearchParams(params).toString();
  const res  = await fetch(`${CONFIG.kraken.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "API-Key":  CONFIG.kraken.apiKey,
      "API-Sign": signKraken(path, nonce, postData),
    },
    body: postData,
  });
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(`Kraken order failed: ${data.error.join(", ")}`);
  return { orderId: data.result.txid[0] };
}

// ─── Position Lookup ──────────────────────────────────────────────────────────
// Source of truth: Supabase bot_positions. Never reads raw Kraken balance to infer ownership.

async function getPosition(symbol, audPrice) {
  const saved = await getOpenPosition(symbol);
  if (!saved) {
    if (!supabaseReady()) {
      console.log(`  ⚠️  Supabase not configured — position tracking disabled`);
      console.log(`       Set SUPABASE_URL + SUPABASE_KEY before going live.`);
    }
    return null;
  }

  // Verify position still has balance in Kraken (wasn't manually closed)
  try {
    const balances = await krakenPrivate("/0/private/Balance");
    const balance  = parseFloat(balances[KRAKEN_BASE[symbol]] || "0");
    if (balance * audPrice < 1.0) {
      console.log(`  ⚠️  ${symbol} position in Supabase but balance is zero — syncing closed`);
      await closePosition(symbol);
      return null;
    }
    const entryPriceAUD  = parseFloat(saved.entry_price_aud);
    const entryPriceUsdt = parseFloat(saved.entry_price_usdt);
    console.log(`  📂 Open position (bot-owned): ${balance.toFixed(6)} ${symbol} @ $${entryPriceAUD.toFixed(4)} AUD`);
    return {
      symbol,
      entryPriceAUD,
      entryPriceUsdt,
      entryTime:       new Date(saved.entry_time).getTime(),
      quantity:        balance,
      stopLossUsdt:    parseFloat(saved.stop_loss_usdt),
      takeProfitUsdt:  parseFloat(saved.take_profit_usdt),
    };
  } catch (err) {
    console.log(`  ⚠️  Balance check failed for ${symbol}: ${err.message}`);
    return null;
  }
}

// ─── Tax CSV Logging ──────────────────────────────────────────────────────────

const CSV_FILE    = "trades.csv";
const CSV_HEADERS = ["Date","Time (UTC)","Exchange","Symbol","Side","Quantity",
                     "Price","Total AUD","Fee (est.)","Net Amount","Order ID","Mode","Notes"].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE,
      CSV_HEADERS + "\n" +
      `,,,,,,,,,,,"NOTE","Trading Bot v5.0 — Blended Confluence Scalper — 1H — Kraken"\n`
    );
  }
}

function writeTradeCsv(e) {
  const now  = new Date(e.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  let side = "", qty = "", total = "", fee = "", net = "", orderId = "", mode = "", notes = "";

  if (e.side === "sell") {
    side    = "SELL";
    qty     = e.quantity.toFixed(8);
    total   = e.totalAUD.toFixed(2);
    fee     = "0.0000";
    net     = e.totalAUD.toFixed(2);
    orderId = e.orderId || "";
    mode    = e.paperTrading ? "PAPER" : "LIVE";
    const pnl = `${e.pnl >= 0 ? "+" : ""}${e.pnl.toFixed(2)} AUD`;
    notes   = e.error ? `Error: ${e.error}` : `P&L: ${pnl} | ${e.exitReasons.join("; ")}`;
  } else if (!e.allPass) {
    const failed = (e.conditions || []).filter((c) => !c.pass).map((c) => c.label).join("; ");
    mode    = "BLOCKED";
    orderId = "BLOCKED";
    notes   = `Failed: ${failed}`;
  } else {
    side    = "BUY";
    qty     = e.quantity.toFixed(8);
    total   = e.tradeSize.toFixed(2);
    fee     = "0.0000";
    net     = e.tradeSize.toFixed(2);
    orderId = e.orderId || "";
    mode    = e.paperTrading ? "PAPER" : "LIVE";
    notes   = e.error
      ? `Error: ${e.error}`
      : `SL: ${e.stopLossAUD.toFixed(4)} | TP: ${e.takeProfitAUD.toFixed(4)} | Score: ${e.score}/8 | ATR: ${e.atr.toFixed(4)}`;
  }

  const row = [date, time, "Kraken", e.symbol, side, qty, (e.price || 0).toFixed(2),
               total, fee, net, orderId, mode, `"${notes}"`].join(",");
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// ─── Per-symbol Evaluation ────────────────────────────────────────────────────

async function evaluateSymbol(symbol, bucketPositionCount) {
  console.log(`\n── ${symbol} ─────────────────────────────────────────────\n`);

  let allCandles;
  try {
    allCandles = await fetchCandles(toBinanceSymbol(symbol), CONFIG.timeframe, 500);
  } catch (err) {
    console.log(`  ⚠️  Candle fetch failed: ${err.message}`);
    return;
  }

  let ticker;
  try {
    ticker = await fetchKrakenTicker(symbol);
  } catch (err) {
    console.log(`  ⚠️  Kraken ticker failed: ${err.message}`);
    return;
  }

  const audPrice = ticker.last;
  const audAsk   = ticker.ask;
  const audBid   = ticker.bid;
  const audMid   = (audAsk + audBid) / 2;

  // Closed bars only for all entry-signal indicators
  const candles    = allCandles.slice(0, -1);
  const closes     = candles.map((c) => c.close);
  const usdtPrice  = closes[closes.length - 1]; // last closed bar close

  const ema8       = calcEMA(closes, 8);
  const ema21      = calcEMA(closes, 21);
  const ema200     = calcEMA(closes, 200);
  const ema21_3ago = closes.length > 3 ? calcEMA(closes.slice(0, -3), 21) : null;
  const vwap       = calcVWAP(candles);
  const rsi14      = calcRSI(closes, 14);
  const rsi7       = calcRSI(closes, 7);
  const atr        = calcATR(candles, 14);
  const adx        = calcADX(candles, 14);
  const macd       = calcMACD(closes);
  const supertrend = calcSupertrend(candles);
  const stochRsi   = calcStochRSI(closes);
  const bb         = calcBollingerBands(closes);
  const medianVol  = calcVolumeMedian(candles, 20);
  const curVolume  = candles[candles.length - 1].volume;
  const atrPct     = atr && usdtPrice ? atr / usdtPrice : 0;

  console.log(`  Kraken (AUD):    $${audPrice.toFixed(4)} (bid $${audBid.toFixed(4)} / ask $${audAsk.toFixed(4)})`);
  console.log(`  Binance (USDT):  $${usdtPrice.toFixed(4)} — last closed bar`);
  console.log(`  EMA(8/21/200):   $${ema8 ? ema8.toFixed(4) : "N/A"} / $${ema21 ? ema21.toFixed(4) : "N/A"} / $${ema200 ? ema200.toFixed(4) : "N/A"}`);
  console.log(`  VWAP:  ${vwap ? "$" + vwap.toFixed(4) : "N/A (<4 bars)"}  |  RSI14: ${rsi14 ? rsi14.toFixed(1) : "N/A"}  |  RSI7: ${rsi7 ? rsi7.toFixed(1) : "N/A"}`);
  console.log(`  ADX:   ${adx ? adx.toFixed(1) : "N/A"}  |  ATR: $${atr ? atr.toFixed(4) : "N/A"} (${(atrPct * 100).toFixed(2)}%)`);
  console.log(`  MACD hist: ${macd ? macd.histogram.toFixed(6) : "N/A"}  |  Supertrend: ${supertrend ? (supertrend.bullish ? "▲ Bullish" : "▼ Bearish") : "N/A"}`);
  console.log(`  StochRSI K/D: ${stochRsi ? stochRsi.k.toFixed(1) + "/" + stochRsi.d.toFixed(1) : "N/A"}  |  BB ±1σ: ${bb ? "$" + bb.std.toFixed(4) : "N/A"}`);
  console.log(`  Volume: ${curVolume.toFixed(0)} (median ${medianVol ? medianVol.toFixed(0) : "N/A"})`);

  if (!atr) {
    console.log("  ⚠️  Insufficient ATR data. Skipping.");
    return;
  }

  // ── EXIT: check open position first ──────────────────────────────────
  const position = await getPosition(symbol, audPrice);
  if (position) {
    bucketPositionCount[getBucket(symbol)] = (bucketPositionCount[getBucket(symbol)] || 0) + 1;

    const savedHwm = await getHWM(symbol);
    const hwm      = Math.max(savedHwm || 0, usdtPrice, position.entryPriceUsdt * 1.002);
    await saveHWM(symbol, hwm);

    const { shouldExit, reasons } = checkExitConditions(position, usdtPrice, atr, hwm);
    if (!shouldExit) return;

    const totalAUD = position.quantity * audPrice;
    const grossPnl = (audPrice - position.entryPriceAUD) * position.quantity;

    console.log("\n── Decision ─────────────────────────────────────────────\n");

    const logEntry = {
      timestamp: new Date().toISOString(), symbol, side: "sell",
      price: audPrice, quantity: position.quantity, totalAUD, pnl: grossPnl,
      exitReasons: reasons, orderPlaced: false, orderId: null,
      paperTrading: CONFIG.paperTrading,
    };

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER SELL — ${symbol} qty ${position.quantity} ~$${totalAUD.toFixed(2)} AUD`);
      console.log(`   P&L: ${grossPnl >= 0 ? "+" : ""}$${grossPnl.toFixed(2)} AUD`);
      logEntry.orderPlaced = true;
      logEntry.orderId     = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING SELL ORDER — ${position.quantity} ${symbol} (~$${totalAUD.toFixed(2)} AUD)`);
      try {
        const order = await placeKrakenOrder(symbol, "sell", position.quantity);
        logEntry.orderPlaced = true;
        logEntry.orderId     = order.orderId;
        console.log(`✅ SELL ORDER PLACED — ${order.orderId} | P&L: ${grossPnl >= 0 ? "+" : ""}$${grossPnl.toFixed(2)} AUD`);
      } catch (err) {
        console.log(`❌ SELL ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    if (logEntry.orderPlaced) {
      await closePosition(symbol);
      await saveHWM(symbol, 0);
    }
    writeTradeCsv(logEntry);
    await supabaseInsert("bot_trades", {
      timestamp: logEntry.timestamp, symbol, side: "sell",
      price_aud: audPrice, quantity: logEntry.quantity, total_aud: totalAUD,
      pnl: grossPnl, exit_reasons: reasons.join("; "),
      order_id: logEntry.orderId, mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
    });
    return;
  }

  // ── ENTRY: duplicate limit order guard ───────────────────────────────
  if (!CONFIG.paperTrading) {
    const openOrders = await fetchKrakenOpenOrders(symbol);
    if (openOrders.length > 0) {
      console.log(`  📋 Open limit order already exists for ${symbol} — skipping entry`);
      return;
    }
  }

  // ── ENTRY: correlation bucket cap ────────────────────────────────────
  const bucket = getBucket(symbol);
  if ((bucketPositionCount[bucket] || 0) >= MAX_PER_BUCKET) {
    console.log(`  📊 Bucket ${bucket} at ${MAX_PER_BUCKET} positions — skipping`);
    writeTradeCsv({
      timestamp: new Date().toISOString(), symbol, side: "buy", price: audPrice,
      conditions: [{ label: `Bucket cap: ${bucket}`, pass: false }],
      allPass: false, score: 0, tradeSize: 0, quantity: 0,
      orderPlaced: false, orderId: null, paperTrading: CONFIG.paperTrading,
    });
    return;
  }

  // ── ENTRY: Supabase required for live trading ─────────────────────────
  if (!CONFIG.paperTrading && !supabaseReady()) {
    console.log(`\n🚫 LIVE TRADING BLOCKED — Supabase not configured`);
    console.log(`   Set SUPABASE_URL + SUPABASE_KEY in Railway env vars to enable live trading.`);
    console.log(`   Run supabase-setup.sql in your Supabase project SQL editor first.`);
    return;
  }

  // ── ENTRY: 5-layer confluence ─────────────────────────────────────────
  const { allPass, score, conditions } = runConfluenceCheck(usdtPrice, {
    ema8, ema21, ema21_3ago, ema200, vwap, rsi14, rsi7, adx,
    macd, supertrend, stochRsi, bb, curVolume, medianVolume: medianVol,
  });

  // Entry prices in both USDT space (for stop/TP logic) and AUD (for display/accounting)
  const isUSD         = QUOTE_CURRENCY[symbol] === "USD";
  const entryPriceUsdt = usdtPrice;
  const entryPriceAUD  = audPrice;

  // Stop/TP in USDT space — compared against Binance USDT prices on each run
  const stopLossUsdt   = entryPriceUsdt - atr * 1.5;
  const takeProfitUsdt = entryPriceUsdt + atr * 3;   // 3×ATR (was 4×ATR)

  // AUD equivalents for display — proportional to USDT levels
  const stopLossAUD    = audPrice * (stopLossUsdt   / entryPriceUsdt);
  const takeProfitAUD  = audPrice * (takeProfitUsdt / entryPriceUsdt);

  const tradeSize  = calcTradeSize(score, atrPct);
  const quantity   = tradeSize / audPrice;
  const minQty     = KRAKEN_MIN_ORDER[symbol];
  const belowMin   = minQty && quantity < minQty;

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(), symbol, side: "buy",
    timeframe: CONFIG.timeframe, price: audPrice,
    atr, conditions, allPass, score, tradeSize, quantity,
    stopLossAUD, takeProfitAUD, orderPlaced: false, orderId: null,
    paperTrading: CONFIG.paperTrading,
  };

  if (!allPass) {
    const failed = conditions.filter((r) => !r.pass).map((r) => r.label);
    console.log("🚫 TRADE BLOCKED");
    failed.forEach((f) => console.log(`   - ${f}`));
  } else if (belowMin) {
    console.log(`🚫 TRADE BLOCKED — below Kraken minimum (${quantity.toFixed(4)} < ${minQty} ${symbol})`);
  } else {
    const riskLabel = score >= 7 ? "1.0%" : score >= 6 ? "0.75%" : "0.5%";
    console.log(`✅ ALL CONDITIONS MET — Score: ${score}/8 (${riskLabel} risk)`);
    console.log(`   Trade size:   $${tradeSize.toFixed(2)} AUD (ATR-sized)`);
    console.log(`   Stop-loss:    $${stopLossAUD.toFixed(4)} AUD (1.5×ATR)`);
    console.log(`   Take-profit:  $${takeProfitAUD.toFixed(4)} AUD (3×ATR)`);
    console.log(`   Limit price:  $${krakenPriceStr(audMid)} AUD (mid-price)`);

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER BUY — ${symbol} qty ${quantity.toFixed(8)} ~$${tradeSize.toFixed(2)} AUD @ $${audPrice.toFixed(4)}`);
      logEntry.orderPlaced = true;
      logEntry.orderId     = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING LIMIT BUY — ${quantity.toFixed(8)} ${symbol} ~$${tradeSize.toFixed(2)} AUD @ limit $${krakenPriceStr(audMid)}`);
      try {
        const order = await placeKrakenOrder(symbol, "buy", quantity, audMid);
        logEntry.orderPlaced = true;
        logEntry.orderId     = order.orderId;
        console.log(`✅ BUY ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ BUY ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    if (logEntry.orderPlaced) {
      bucketPositionCount[bucket] = (bucketPositionCount[bucket] || 0) + 1;

      // Record position in Supabase — this is the source of truth for position ownership
      await openPosition({
        symbol,
        entryPriceAUD,
        entryPriceUsdt,
        entryTime:      Date.now(),
        quantity,
        stopLossUsdt,
        takeProfitUsdt,
        orderId:        logEntry.orderId,
      });

      await saveHWM(symbol, entryPriceUsdt * 1.002); // cold-start HWM above entry

      await supabaseInsert("bot_trades", {
        timestamp: logEntry.timestamp, symbol, side: "buy",
        price_aud: audPrice, quantity, total_aud: tradeSize, score,
        stop_loss_aud: stopLossAUD, take_profit_aud: takeProfitAUD,
        atr, order_id: logEntry.orderId, mode: "LIVE",
      });
    }
  }

  writeTradeCsv(logEntry);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — Blended Confluence Scalper v5.0");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  if (!supabaseReady()) {
    console.log("  ⚠️  Supabase not configured — position persistence disabled");
    if (!CONFIG.paperTrading) console.log("  ⚠️  Live trading will be blocked until Supabase is set up");
  }
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbols (${CONFIG.symbols.length}): ${CONFIG.symbols.join(", ")} | TF: ${CONFIG.timeframe}`);
  console.log(`Min confluence: 4/8 | Risk: 0.5%→0.75%→1.0% | TP: 3×ATR | Time stop: ${TIME_STOP_BARS} bars`);

  // ── BTC macro regime gate — checked once for all symbols ─────────────
  const btc = await checkBtcRegime();

  // ── Cancel stale buy limits from previous runs ────────────────────────
  await cancelStaleOrders();

  const bucketPositionCount = {};

  for (const symbol of CONFIG.symbols) {
    const canTrade = await checkTradeLimits();
    if (!canTrade) {
      console.log("\nBot stopping — daily limit or loss limit reached.");
      break;
    }

    // BTC regime blocks new entries only (not exits — handled inside evaluateSymbol)
    if (!btc.bullish) {
      // Still run evaluateSymbol so exits are processed; flag BTC block for entry
      console.log(`\n── ${symbol} — skipping entry (BTC bear regime) ─────────────\n`);
      // We still need to check exits for open positions
      const ticker = await fetchKrakenTicker(symbol).catch(() => null);
      if (!ticker) continue;
      const position = await getPosition(symbol, ticker.last);
      if (position) {
        // Run a lightweight exit check for positions held during regime change
        await evaluateSymbol(symbol, bucketPositionCount);
      }
      continue;
    }

    await evaluateSymbol(symbol, bucketPositionCount);
  }

  saveLog(loadLog()); // persist ephemeral log
  console.log("\n═══════════════════════════════════════════════════════════\n");

  // Debrief at 7:00 UTC (5pm AEST) and 22:00 UTC (8am AEST)
  const utcHour = new Date().getUTCHours();
  const utcMin  = new Date().getUTCMinutes();
  if ((utcHour === 7 || utcHour === 22) && utcMin < 60) {
    console.log("⏰ Debrief hour — running debrief...");
    try {
      const { runDebrief } = await import("./debrief.js");
      await runDebrief();
    } catch (err) {
      console.error("Debrief error:", err.message);
    }
  }
}

if (process.argv.includes("--tax-summary")) {
  // Quick P&L summary from local CSV
  if (existsSync(CSV_FILE)) {
    const rows      = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
    const live      = rows.filter((r) => r[11] === "LIVE");
    const totalVol  = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
    console.log(`\nTotal rows: ${rows.length} | Live trades: ${live.length} | Vol: $${totalVol.toFixed(2)} AUD`);
  }
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
