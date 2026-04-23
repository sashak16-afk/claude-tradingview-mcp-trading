/**
 * Claude + TradingView MCP — Automated Trading Bot v4.0
 *
 * Strategy: Blended Confluence Scalper v4.0
 * Timeframe: 15m  |  Cron: every 15 minutes  |  Exchange: Kraken
 *
 * Changes from v3.0:
 *   - 15m timeframe (was 1H) — more dynamic, more frequent signals
 *   - ADX(14) > 20 replaces the old VWAP distance gate (confirms trending market)
 *   - VWAP gate loosened to ±0.5% symmetric (was 0.2% below-only)
 *   - RSI(14) gate lowered to > 45 (was > 50) — allows deeper pullbacks
 *   - RSI(7) Layer 4 changed to 45–65 range (was < 35 — contradicted RSI14 gate)
 *   - StochRSI Layer 4 changed to %K > %D AND %K < 80 (was cross from <50 — rarely fired)
 *   - BB Layer 4 changed to within middle ± 1σ (was within 2% of lower band)
 *   - Volume check uses 20-bar median instead of mean (robust to illiquid AUD spikes)
 *   - Volume threshold lowered to 35% of median (was 50% of mean)
 *   - Minimum confluence score: 4/8 (was 5/8)
 *   - Supertrend multiplier: 2.0 (was 3.0) — faster flips on 15m
 *   - Take-profit: 4×ATR (was fixed 10%) — proportional to volatility
 *   - Trade sizing: ATR-based risk model (was fixed at min floor due to bug)
 *   - Time stop: 96 bars / 24H — frees capital stuck in dead trades
 *   - HWM cold-start fix: never starts below entry + 0.2%
 *   - Correlation bucket cap: max 2 positions per bucket (BTC-beta / Alt-beta / USD)
 *   - Supabase persistent trade + HWM logging (optional, needs env vars)
 *   - Removed SEIUSD, NEARUSD from all maps
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
      "TIMEFRAME=15m",
      "",
      "# Telegram — debrief",
      "TELEGRAM_BOT_TOKEN=",
      "TELEGRAM_CHAT_ID=",
      "",
      "# Supabase — persistent trade log (optional)",
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
  symbols:        (process.env.SYMBOLS || "XBTAUD").split(",").map((s) => s.trim()).filter(Boolean),
  timeframe:      process.env.TIMEFRAME || "15m",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeAUD: parseFloat(process.env.MAX_TRADE_SIZE_AUD || "200"),
  minTradeSizeAUD: parseFloat(process.env.MIN_TRADE_SIZE_AUD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "10"),
  paperTrading:   process.env.PAPER_TRADING !== "false",
  kraken: {
    apiKey:    process.env.KRAKEN_API_KEY,
    apiSecret: process.env.KRAKEN_API_SECRET,
    baseUrl:   "https://api.kraken.com",
  },
};

// Minutes per bar — used for time-stop calculation
const TF_MAP = { "1m":1,"3m":3,"5m":5,"15m":15,"30m":30,"1H":60,"4H":240,"1D":1440 };
const TF_MINUTES   = TF_MAP[CONFIG.timeframe] || 15;
const TIME_STOP_BARS = Math.ceil(24 * 60 / TF_MINUTES); // 96 bars @ 15m = 24H

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

// ─── Logging (local ephemeral — Railway container) ────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter((t) => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

// ─── Supabase (optional persistent logging + HWM) ────────────────────────────

async function supabaseInsert(table, row) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": key,
        "Authorization": `Bearer ${key}`,
        "Prefer": "return=minimal",
      },
      body: JSON.stringify(row),
    });
  } catch (err) {
    console.log(`  ⚠️  Supabase insert failed (${table}): ${err.message}`);
  }
}

async function supabaseUpsert(table, row, conflictCol) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/${table}?on_conflict=${conflictCol}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": key,
        "Authorization": `Bearer ${key}`,
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
    });
  } catch (err) {
    console.log(`  ⚠️  Supabase upsert failed (${table}): ${err.message}`);
  }
}

async function getHWMFromSupabase(symbol) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  try {
    const res  = await fetch(`${url}/rest/v1/bot_state?key=eq.hwm_${symbol}&select=value`, {
      headers: { "apikey": key, "Authorization": `Bearer ${key}` },
    });
    const data = await res.json();
    return data[0] ? parseFloat(data[0].value) : null;
  } catch {
    return null;
  }
}

async function saveHWMToSupabase(symbol, hwm) {
  await supabaseUpsert("bot_state", {
    key:        `hwm_${symbol}`,
    value:      hwm > 0 ? hwm.toString() : null,
    updated_at: new Date().toISOString(),
  }, "key");
}

// ─── Symbol Maps ──────────────────────────────────────────────────────────────

const BINANCE_SYMBOL_MAP = {
  XBTAUD:  "BTCUSDT",
  ETHAUD:  "ETHUSDT",
  SOLAUD:  "SOLUSDT",
  XRPAUD:  "XRPUSDT",
  XDGAUD:  "DOGEUSDT",
  LINKAUD: "LINKUSDT",
  ADAAUD:  "ADAUSDT",
  DOTUSD:  "DOTUSDT",
  UNIUSD:  "UNIUSDT",
  ATOMUSD: "ATOMUSDT",
  XBTUSDT: "BTCUSDT",
  XDGUSDT: "DOGEUSDT",
};

function toBinanceSymbol(s) {
  return BINANCE_SYMBOL_MAP[s] || s;
}

const KRAKEN_BASE = {
  XBTAUD:  "XXBT",
  ETHAUD:  "XETH",
  SOLAUD:  "SOL",
  XRPAUD:  "XXRP",
  XDGAUD:  "XXDG",
  LINKAUD: "LINK",
  ADAAUD:  "ADA",
  DOTUSD:  "DOT",
  UNIUSD:  "UNI",
  ATOMUSD: "ATOM",
};

const KRAKEN_PAIR_PATTERN = {
  XBTAUD:  "XBT",
  ETHAUD:  "ETH",
  SOLAUD:  "SOL",
  XRPAUD:  "XRP",
  XDGAUD:  "XDG",
  LINKAUD: "LINK",
  ADAAUD:  "ADA",
  DOTUSD:  "DOT",
  UNIUSD:  "UNI",
  ATOMUSD: "ATOM",
};

const KRAKEN_MIN_ORDER = {
  LINKAUD: 1,
};

// ─── Kraken live price (AUD) ──────────────────────────────────────────────────

async function fetchKrakenTicker(symbol) {
  const res  = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${symbol}`);
  const data = await res.json();
  if (data.error && data.error.length > 0) throw new Error(`Kraken ticker: ${data.error.join(", ")}`);
  const t = Object.values(data.result)[0];
  return {
    last: parseFloat(t.c[0]),
    ask:  parseFloat(t.a[0]),
    bid:  parseFloat(t.b[0]),
  };
}

// ─── Market Data (Binance public API — no auth needed) ────────────────────────

async function fetchCandles(symbol, interval, limit = 500) {
  const binanceInterval = TF_MAP[interval] ? (
    interval === "1H"  ? "1h"  :
    interval === "4H"  ? "4h"  :
    interval === "1D"  ? "1d"  :
    interval === "1W"  ? "1w"  :
    interval.toLowerCase()
  ) : "15m";

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

// ADX(14) — > 20 = trending, > 40 = strong trend. Uses Wilder's smoothing.
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

  let smoothTR  = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dxSeries = [];
  const pushDX = () => {
    const pdi = smoothTR > 0 ? (smoothPDM / smoothTR) * 100 : 0;
    const mdi = smoothTR > 0 ? (smoothMDM / smoothTR) * 100 : 0;
    const sum = pdi + mdi;
    dxSeries.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  };
  pushDX();

  for (let i = period; i < tr.length; i++) {
    smoothTR  = smoothTR  - smoothTR  / period + tr[i];
    smoothPDM = smoothPDM - smoothPDM / period + plusDM[i];
    smoothMDM = smoothMDM - smoothMDM / period + minusDM[i];
    pushDX();
  }

  if (dxSeries.length < period) return null;
  return dxSeries.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Session VWAP — resets at midnight UTC. On 15m = up to 96 bars/session.
function calcVWAP(candles) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const session = candles.filter((c) => c.time >= midnight.getTime());
  if (session.length === 0) return null;
  const tpv = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol  = session.reduce((s, c) => s + c.volume, 0);
  return vol === 0 ? null : tpv / vol;
}

// MACD — returns { histogram, prevHistogram } or null
function calcMACD(closes, fast = 12, slow = 26, sigPeriod = 9) {
  if (closes.length < slow + sigPeriod + 2) return null;

  const macdLine = [];
  for (let end = slow; end <= closes.length; end++) {
    const s = closes.slice(0, end);
    macdLine.push(calcEMA(s, fast) - calcEMA(s, slow));
  }
  if (macdLine.length < sigPeriod + 2) return null;

  const mult = 2 / (sigPeriod + 1);
  let sig = macdLine.slice(0, sigPeriod).reduce((a, b) => a + b, 0) / sigPeriod;
  const sigSeries = [sig];
  for (let i = sigPeriod; i < macdLine.length; i++) {
    sig = macdLine[i] * mult + sig * (1 - mult);
    sigSeries.push(sig);
  }

  const n = sigSeries.length;
  return {
    histogram:     macdLine[sigPeriod - 1 + n - 1] - sigSeries[n - 1],
    prevHistogram: macdLine[sigPeriod - 1 + n - 2] - sigSeries[n - 2],
  };
}

// Supertrend (ATR 10, multiplier 2.0) — faster flips than 3.0, better for 15m
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
  const atrSeries = [];
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atrSeries.push(atr);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrSeries.push(atr);
  }

  let trend = 1, finalUpper = 0, finalLower = 0;
  for (let i = 0; i < atrSeries.length; i++) {
    const ci  = i + period;
    const hl2 = (candles[ci].high + candles[ci].low) / 2;
    const bU  = hl2 + multiplier * atrSeries[i];
    const bL  = hl2 - multiplier * atrSeries[i];
    const newU = i === 0 ? bU : (candles[ci - 1].close < finalUpper ? Math.min(bU, finalUpper) : bU);
    const newL = i === 0 ? bL : (candles[ci - 1].close > finalLower ? Math.max(bL, finalLower) : bL);
    const close = candles[ci].close;
    if      (trend === -1 && close > newU) trend = 1;
    else if (trend ===  1 && close < newL) trend = -1;
    finalUpper = newU;
    finalLower = newL;
  }
  return { bullish: trend === 1 };
}

// StochRSI — returns { k, d, prevK, prevD } or null
function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  if (closes.length < rsiPeriod + stochPeriod + kSmooth + dSmooth + 2) return null;

  const rsiSeries = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    const r = calcRSI(closes.slice(0, i + 1), rsiPeriod);
    if (r !== null) rsiSeries.push(r);
  }
  if (rsiSeries.length < stochPeriod + kSmooth + dSmooth + 2) return null;

  const rawK = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
    const w  = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const hi = Math.max(...w), lo = Math.min(...w);
    rawK.push(hi === lo ? 50 : (rsiSeries[i] - lo) / (hi - lo) * 100);
  }

  const kSeries = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    kSeries.push(rawK.slice(i - kSmooth + 1, i + 1).reduce((a, b) => a + b, 0) / kSmooth);
  }

  const dSeries = [];
  for (let i = dSmooth - 1; i < kSeries.length; i++) {
    dSeries.push(kSeries.slice(i - dSmooth + 1, i + 1).reduce((a, b) => a + b, 0) / dSmooth);
  }

  if (kSeries.length < 2 || dSeries.length < 2) return null;
  return {
    k:     kSeries[kSeries.length - 1],
    d:     dSeries[dSeries.length - 1],
    prevK: kSeries[kSeries.length - 2],
    prevD: dSeries[dSeries.length - 2],
  };
}

// Bollinger Bands — returns { upper, middle, lower, std } or null
function calcBollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const recent = closes.slice(-period);
  const middle = recent.reduce((a, b) => a + b, 0) / period;
  const std    = Math.sqrt(recent.reduce((s, c) => s + Math.pow(c - middle, 2), 0) / period);
  return { upper: middle + stdDev * std, middle, lower: middle - stdDev * std, std };
}

// Volume median — more robust than mean for illiquid AUD pairs with volume spikes
function calcVolumeMedian(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const vols = candles.slice(-period - 1, -1).map((c) => c.volume).sort((a, b) => a - b);
  const mid  = Math.floor(vols.length / 2);
  return vols.length % 2 === 0 ? (vols[mid - 1] + vols[mid]) / 2 : vols[mid];
}

// ─── 5-Layer Confluence Check (v4.0) ─────────────────────────────────────────

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
  chk("Price above EMA(200)",
    g1, `price ${price.toFixed(4)} vs EMA200 ${ema200 ? ema200.toFixed(4) : "N/A"}`);

  const vwapDist = vwap ? Math.abs((price - vwap) / vwap) * 100 : 999;
  const g2 = vwapDist <= 0.5;
  chk("Price within ±0.5% of VWAP",
    g2, `${vwapDist.toFixed(2)}% from VWAP ${vwap ? vwap.toFixed(4) : "N/A"}`);

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
    (curVolume && medianVolume)
      ? `cur ${curVolume.toFixed(0)} vs median ${medianVolume.toFixed(0)}`
      : "N/A");
  if (l3c) score++;

  // ── Layer 4: Entry timing — 3 pts ────────────────────────────────────
  console.log("\n── Layer 4: Entry Timing (3 pts) ───────────────────────\n");

  // 45–65: pullback within uptrend. Not deeply oversold (contradicts RSI14>45 gate)
  // and not overbought (would mean chasing).
  const l4a = rsi7 !== null && rsi7 >= 45 && rsi7 <= 65;
  chk("RSI(7) between 45–65 — momentum pullback [+1]", l4a,
    rsi7 ? `RSI7 = ${rsi7.toFixed(1)}` : "N/A");
  if (l4a) score++;

  // %K > %D = momentum up; %K < 80 = not yet overbought
  const l4b = stochRsi !== null && stochRsi.k > stochRsi.d && stochRsi.k < 80;
  chk("StochRSI %K > %D and < 80 [+1]", l4b,
    stochRsi ? `K=${stochRsi.k.toFixed(1)} D=${stochRsi.d.toFixed(1)}` : "N/A");
  if (l4b) score++;

  // Within middle ± 1σ: in the comfortable mid-range, not at extremes
  const l4c = bb !== null && Math.abs(price - bb.middle) <= bb.std;
  chk("Price within middle BB ± 1σ [+1]", l4c,
    bb ? `price ${price.toFixed(4)}, mid ${bb.middle.toFixed(4)} ±1σ ${bb.std.toFixed(4)}` : "N/A");
  if (l4c) score++;

  const allPass = score >= 4;
  console.log(`\n── Confluence Score: ${score}/8 — ${allPass ? "✅ TRADE SIGNAL" : "🚫 need 4 minimum"}\n`);
  return { allPass, score, conditions, direction: "LONG" };
}

// ─── Trade Size (ATR-based risk model) ───────────────────────────────────────
// Sizes so that hitting the 1.5×ATR stop loses exactly riskAUD.
// tradeSize_AUD = riskAUD / (atrPct × 1.5), capped at [min, max].

function calcTradeSize(score, atrPct) {
  const riskPct  = score >= 7 ? 0.010 : score >= 6 ? 0.0075 : 0.005;
  const riskAUD  = CONFIG.portfolioValue * riskPct;
  const stopPct  = atrPct * 1.5;
  const atrSized = stopPct > 0 ? riskAUD / stopPct : CONFIG.minTradeSizeAUD;
  return Math.max(Math.min(atrSized, CONFIG.maxTradeSizeAUD), CONFIG.minTradeSizeAUD);
}

// ─── Exit Conditions ──────────────────────────────────────────────────────────

function checkExitConditions(position, price, atr, highWaterMark) {
  const reasons      = [];
  const trailingStop = highWaterMark - atr * 2.0;

  console.log("\n── Exit Check ───────────────────────────────────────────\n");
  console.log(`  Entry:          $${position.entryPrice.toFixed(4)}`);
  console.log(`  Current:        $${price.toFixed(4)}`);
  console.log(`  High-water:     $${highWaterMark.toFixed(4)}`);
  console.log(`  Trailing stop:  $${trailingStop.toFixed(4)} (HWM − 2.0×ATR)`);
  console.log(`  Hard stop-loss: $${position.stopLoss.toFixed(4)}`);
  console.log(`  Take-profit:    $${position.takeProfit.toFixed(4)} (4×ATR)`);

  if (price <= position.stopLoss)
    reasons.push(`Hard stop hit (${price.toFixed(4)} ≤ ${position.stopLoss.toFixed(4)})`);
  if (price >= position.takeProfit)
    reasons.push(`Take-profit hit (${price.toFixed(4)} ≥ ${position.takeProfit.toFixed(4)})`);
  if (price <= trailingStop)
    reasons.push(`Trailing stop hit (${price.toFixed(4)} ≤ ${trailingStop.toFixed(4)}, HWM ${highWaterMark.toFixed(4)})`);

  if (position.entryTime) {
    const ageBars = (Date.now() - position.entryTime) / (TF_MINUTES * 60 * 1000);
    console.log(`  Position age:   ${Math.round(ageBars)} bars (limit ${TIME_STOP_BARS})`);
    if (ageBars > TIME_STOP_BARS)
      reasons.push(`Time stop: position open ${Math.round(ageBars)} bars (> ${TIME_STOP_BARS} = 24H)`);
  }

  if (reasons.length === 0) console.log("  📊 Holding — no exit condition triggered");
  else reasons.forEach((r) => console.log(`  🚨 ${r}`));

  return { shouldExit: reasons.length > 0, reasons };
}

// ─── Trade Limits ─────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`);
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
      "Content-Type": "application/x-www-form-urlencoded",
      "API-Key":  CONFIG.kraken.apiKey,
      "API-Sign": signKraken(path, nonce, postData),
    },
    body: postData,
  });
  const data = await res.json();
  if (data.error && data.error.length > 0) throw new Error(data.error.join(", "));
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

async function getPositionFromKraken(symbol, audPrice, usdtPrice, atr) {
  const base    = KRAKEN_BASE[symbol];
  const pattern = KRAKEN_PAIR_PATTERN[symbol];
  if (!base || !pattern) return null;

  try {
    const balances = await krakenPrivate("/0/private/Balance");
    const balance  = parseFloat(balances[base] || "0");
    if (balance * audPrice < 1.0) return null;

    const history = await krakenPrivate("/0/private/TradesHistory");
    const trades  = Object.values(history.trades || {});
    const lastBuy = trades
      .filter((t) => t.type === "buy" && t.pair.toUpperCase().includes(pattern))
      .sort((a, b) => b.time - a.time)[0];

    const entryPriceAUD = lastBuy ? parseFloat(lastBuy.price) : audPrice;
    const entryTime     = lastBuy ? lastBuy.time * 1000 : Date.now();
    const entryPrice    = entryPriceAUD * (usdtPrice / audPrice);
    const stopLoss      = entryPrice - atr * 1.5;
    const takeProfit    = entryPrice + atr * 4;

    console.log(`  📂 Open position found: ${balance.toFixed(6)} ${pattern} @ $${entryPriceAUD.toFixed(4)} AUD`);
    return { symbol, entryPrice, entryPriceAUD, entryTime, quantity: balance, stopLoss, takeProfit };

  } catch (err) {
    console.log(`  ⚠️  Position lookup failed: ${err.message}`);
    return null;
  }
}

async function placeKrakenOrder(symbol, side, volume, limitPrice = null) {
  const path     = "/0/private/AddOrder";
  const nonce    = Date.now().toString();
  const params   = {
    nonce, pair: symbol, type: side,
    ordertype: limitPrice ? "limit" : "market",
    volume: parseFloat(volume).toFixed(8),
  };
  if (limitPrice) params.price = limitPrice.toFixed(6);
  const postData = new URLSearchParams(params).toString();

  const res  = await fetch(`${CONFIG.kraken.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "API-Key":  CONFIG.kraken.apiKey,
      "API-Sign": signKraken(path, nonce, postData),
    },
    body: postData,
  });
  const data = await res.json();
  if (data.error && data.error.length > 0) throw new Error(`Kraken order failed: ${data.error.join(", ")}`);
  return { orderId: data.result.txid[0] };
}

// ─── Tax CSV Logging ──────────────────────────────────────────────────────────

const CSV_FILE    = "trades.csv";
const CSV_HEADERS = ["Date","Time (UTC)","Exchange","Symbol","Side","Quantity",
                     "Price","Total AUD","Fee (est.)","Net Amount","Order ID","Mode","Notes"].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE,
      CSV_HEADERS + "\n" +
      `,,,,,,,,,,,"NOTE","Trading Bot v4.0 — Blended Confluence Scalper — 15m — Kraken"\n`
    );
    console.log(`📄 Created ${CSV_FILE}`);
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
      : `SL: ${e.stopLossAUD.toFixed(4)} | TP: ${e.takeProfitAUD.toFixed(4)} | Score: ${e.score}/8 | ATR: ${e.indicators.atr.toFixed(4)}`;
  }

  const row = [date,time,"Kraken",e.symbol,side,qty,e.price.toFixed(2),total,fee,net,orderId,mode,`"${notes}"`].join(",");
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv found."); return; }
  const rows       = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  const live       = rows.filter((r) => r[11] === "LIVE");
  const totalVol   = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
  const totalFees  = live.reduce((s, r) => s + parseFloat(r[8] || 0), 0);
  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total logged   : ${rows.length}`);
  console.log(`  Live trades    : ${live.length}`);
  console.log(`  Paper trades   : ${rows.filter((r) => r[11] === "PAPER").length}`);
  console.log(`  Blocked        : ${rows.filter((r) => r[11] === "BLOCKED").length}`);
  console.log(`  Total vol (AUD): $${totalVol.toFixed(2)}`);
  console.log(`  Total fees     : $${totalFees.toFixed(4)}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Per-symbol Evaluation ────────────────────────────────────────────────────

async function evaluateSymbol(symbol, log, bucketPositionCount) {
  console.log(`\n── ${symbol} ─────────────────────────────────────────────\n`);

  let candles;
  try {
    candles = await fetchCandles(toBinanceSymbol(symbol), CONFIG.timeframe, 500);
  } catch (err) {
    console.log(`  ⚠️  Candle fetch failed: ${err.message}`);
    return;
  }

  let ticker;
  try {
    ticker = await fetchKrakenTicker(symbol);
  } catch (err) {
    console.log(`  ⚠️  Kraken ticker fetch failed: ${err.message}`);
    return;
  }

  const audPrice  = ticker.last;
  const audAsk    = ticker.ask;
  const audBid    = ticker.bid;
  const audMid    = (audAsk + audBid) / 2;
  const closes    = candles.map((c) => c.close);
  const usdtPrice = closes[closes.length - 1];

  // Indicators
  const ema8         = calcEMA(closes, 8);
  const ema21        = calcEMA(closes, 21);
  const ema200       = calcEMA(closes, 200);
  const ema21_3ago   = closes.length > 3 ? calcEMA(closes.slice(0, -3), 21) : null;
  const vwap         = calcVWAP(candles);
  const rsi14        = calcRSI(closes, 14);
  const rsi7         = calcRSI(closes, 7);
  const atr          = calcATR(candles, 14);
  const adx          = calcADX(candles, 14);
  const macd         = calcMACD(closes);
  const supertrend   = calcSupertrend(candles);
  const stochRsi     = calcStochRSI(closes);
  const bb           = calcBollingerBands(closes);
  const medianVolume = calcVolumeMedian(candles, 20);
  const curVolume    = candles[candles.length - 2].volume;
  const atrPct       = atr && usdtPrice ? atr / usdtPrice : 0;

  console.log(`  Kraken (AUD):   $${audPrice.toFixed(4)} (bid $${audBid.toFixed(4)} / ask $${audAsk.toFixed(4)})`);
  console.log(`  Binance (USDT): $${usdtPrice.toFixed(4)} — indicators only`);
  console.log(`  EMA(8/21/200): $${ema8 ? ema8.toFixed(4) : "N/A"} / $${ema21 ? ema21.toFixed(4) : "N/A"} / $${ema200 ? ema200.toFixed(4) : "N/A"}`);
  console.log(`  VWAP:    ${vwap  ? "$" + vwap.toFixed(4) : "N/A"}  |  RSI14: ${rsi14 ? rsi14.toFixed(1) : "N/A"}  |  RSI7: ${rsi7 ? rsi7.toFixed(1) : "N/A"}`);
  console.log(`  ADX(14): ${adx   ? adx.toFixed(1)        : "N/A"}  |  ATR: $${atr ? atr.toFixed(4) : "N/A"} (${(atrPct * 100).toFixed(2)}%)`);
  console.log(`  MACD hist: ${macd ? macd.histogram.toFixed(6) : "N/A"}  |  Supertrend: ${supertrend ? (supertrend.bullish ? "▲ Bullish" : "▼ Bearish") : "N/A"}`);
  console.log(`  StochRSI K/D: ${stochRsi ? stochRsi.k.toFixed(1) + "/" + stochRsi.d.toFixed(1) : "N/A"}  |  BB ±1σ: ${bb ? "$" + bb.std.toFixed(4) : "N/A"}`);
  console.log(`  Volume: ${curVolume.toFixed(0)} (median ${medianVolume ? medianVolume.toFixed(0) : "N/A"})`);

  if (!atr || !vwap) {
    console.log("  ⚠️  Insufficient data. Skipping.");
    return;
  }

  // ── EXIT: check open position first ──────────────────────────────────
  const position = await getPositionFromKraken(symbol, audPrice, usdtPrice, atr);
  if (position) {
    bucketPositionCount[getBucket(symbol)] = (bucketPositionCount[getBucket(symbol)] || 0) + 1;

    // HWM: Supabase → in-memory log → entry+0.2% (never start below entry)
    const supabaseHwm = await getHWMFromSupabase(symbol);
    const savedHwm    = supabaseHwm || log.highWaterMarks?.[symbol] || position.entryPrice;
    const hwm         = Math.max(savedHwm, usdtPrice, position.entryPrice * 1.002);
    if (!log.highWaterMarks) log.highWaterMarks = {};
    log.highWaterMarks[symbol] = hwm;
    await saveHWMToSupabase(symbol, hwm);

    const { shouldExit, reasons } = checkExitConditions(position, usdtPrice, atr, hwm);
    if (!shouldExit) return;

    const totalAUD = position.quantity * audPrice;
    const grossPnl = (audPrice - position.entryPriceAUD) * position.quantity;
    const logEntry = {
      timestamp: new Date().toISOString(), symbol, side: "sell",
      price: audPrice, quantity: position.quantity, totalAUD, pnl: grossPnl,
      exitReasons: reasons, orderPlaced: false, orderId: null,
      paperTrading: CONFIG.paperTrading,
    };

    console.log("\n── Decision ─────────────────────────────────────────────\n");

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
      delete log.highWaterMarks[symbol];
      await saveHWMToSupabase(symbol, 0);
    }
    log.trades.push(logEntry);
    writeTradeCsv(logEntry);
    await supabaseInsert("bot_trades", {
      timestamp: logEntry.timestamp, symbol, side: "sell",
      price_aud: audPrice, quantity: logEntry.quantity, total_aud: totalAUD,
      pnl: grossPnl, exit_reasons: reasons.join("; "),
      order_id: logEntry.orderId, mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
    });
    return;
  }

  // ── ENTRY: guard against duplicate limit orders ──────────────────────
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
    console.log(`  📊 Bucket ${bucket} already at ${MAX_PER_BUCKET} positions — skipping entry`);
    const logEntry = {
      timestamp: new Date().toISOString(), symbol, side: "buy",
      timeframe: CONFIG.timeframe, price: audPrice,
      indicators: { ema8, ema21, ema200, vwap, rsi14, rsi7, adx, atr },
      conditions: [{ label: `Bucket cap: ${bucket}`, pass: false }],
      allPass: false, score: 0, tradeSize: 0, quantity: 0,
      orderPlaced: false, orderId: null, paperTrading: CONFIG.paperTrading,
    };
    log.trades.push(logEntry);
    writeTradeCsv(logEntry);
    return;
  }

  // ── ENTRY: 5-layer confluence check ──────────────────────────────────
  const { allPass, score, conditions } = runConfluenceCheck(usdtPrice, {
    ema8, ema21, ema21_3ago, ema200, vwap, rsi14, rsi7, adx,
    macd, supertrend, stochRsi, bb, curVolume, medianVolume,
  });

  const tradeSize     = calcTradeSize(score, atrPct);
  const quantity      = tradeSize / audPrice;
  const stopLoss      = usdtPrice - atr * 1.5;
  const takeProfit    = usdtPrice + atr * 4;
  const stopLossAUD   = audPrice - audPrice * atrPct * 1.5;
  const takeProfitAUD = audPrice + audPrice * atrPct * 4;

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(), symbol, side: "buy",
    timeframe: CONFIG.timeframe, price: audPrice,
    indicators: { ema8, ema21, ema200, vwap, rsi14, rsi7, adx, atr },
    conditions, allPass, score, tradeSize, quantity,
    stopLoss, takeProfit, stopLossAUD, takeProfitAUD,
    orderPlaced: false, orderId: null, paperTrading: CONFIG.paperTrading,
  };

  const minQty         = KRAKEN_MIN_ORDER[symbol];
  const belowMinVolume = minQty && quantity < minQty;

  if (!allPass) {
    const failed = conditions.filter((r) => !r.pass).map((r) => r.label);
    console.log("🚫 TRADE BLOCKED");
    failed.forEach((f) => console.log(`   - ${f}`));
  } else if (belowMinVolume) {
    console.log(`🚫 TRADE BLOCKED — below Kraken minimum order (${quantity.toFixed(4)} < ${minQty} ${symbol})`);
    console.log(`   Fix: increase MIN_TRADE_SIZE_AUD or remove ${symbol} from SYMBOLS`);
  } else {
    const riskLabel = score >= 7 ? "1.0%" : score >= 6 ? "0.75%" : "0.5%";
    console.log(`✅ ALL CONDITIONS MET — Score: ${score}/8 (${riskLabel} risk)`);
    console.log(`   Trade size:  $${tradeSize.toFixed(2)} AUD (ATR-sized)`);
    console.log(`   Stop-loss:   $${stopLossAUD.toFixed(4)} AUD (1.5×ATR)`);
    console.log(`   Take-profit: $${takeProfitAUD.toFixed(4)} AUD (4×ATR)`);
    console.log(`   Limit price: $${audMid.toFixed(6)} AUD (mid-price — maker target)`);

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — ${symbol} qty ${quantity.toFixed(8)} ~$${tradeSize.toFixed(2)} AUD @ $${audPrice.toFixed(4)}`);
      logEntry.orderPlaced = true;
      logEntry.orderId     = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING LIMIT BUY — ${quantity.toFixed(8)} ${symbol} (~$${tradeSize.toFixed(2)} AUD) limit $${audMid.toFixed(6)} AUD`);
      try {
        const order = await placeKrakenOrder(symbol, "buy", quantity, audMid);
        logEntry.orderPlaced = true;
        logEntry.orderId     = order.orderId;
        console.log(`✅ BUY ORDER PLACED — ${order.orderId} (limit @ $${audMid.toFixed(6)} AUD)`);
      } catch (err) {
        console.log(`❌ BUY ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    if (logEntry.orderPlaced) {
      bucketPositionCount[bucket] = (bucketPositionCount[bucket] || 0) + 1;
      await supabaseInsert("bot_trades", {
        timestamp: logEntry.timestamp, symbol, side: "buy",
        price_aud: audPrice, quantity, total_aud: tradeSize, score,
        stop_loss_aud: stopLossAUD, take_profit_aud: takeProfitAUD,
        atr, order_id: logEntry.orderId, mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
      });
    }
  }

  log.trades.push(logEntry);
  writeTradeCsv(logEntry);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — Blended Confluence Scalper v4.0");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbols (${CONFIG.symbols.length}): ${CONFIG.symbols.join(", ")} | TF: ${CONFIG.timeframe}`);
  console.log(`Min confluence: 4/8 | Risk: 0.5% → 0.75% → 1.0% | Time stop: ${TIME_STOP_BARS} bars`);

  const log                = loadLog();
  const bucketPositionCount = {};

  for (const symbol of CONFIG.symbols) {
    if (!checkTradeLimits(log)) {
      console.log("\nBot stopping — daily trade limit reached.");
      break;
    }
    await evaluateSymbol(symbol, log, bucketPositionCount);
  }

  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Debrief at 7:00 UTC (5pm AEST) and 22:00 UTC (8am AEST)
  const utcHour = new Date().getUTCHours();
  if (utcHour === 7 || utcHour === 22) {
    const utcMin = new Date().getUTCMinutes();
    if (utcMin < 15) { // only fire on the first 15m slot of that hour
      console.log("⏰ Debrief hour — running debrief...");
      try {
        const { runDebrief } = await import("./debrief.js");
        await runDebrief();
      } catch (err) {
        console.error("Debrief error:", err.message);
      }
    }
  }
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
