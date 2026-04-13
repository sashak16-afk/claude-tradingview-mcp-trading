/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs 5-layer confluence
 * check, executes via Kraken if score >= 5/7.
 *
 * Local mode:  node bot.js
 * Cloud mode:  deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["KRAKEN_API_KEY", "KRAKEN_API_SECRET"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length === 0) return;

  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file found — opening it for you to fill in...\n");
    writeFileSync(
      ".env",
      [
        "# Kraken credentials",
        "KRAKEN_API_KEY=",
        "KRAKEN_API_SECRET=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=500",
        "MAX_TRADE_SIZE_AUD=50",
        "MAX_TRADES_PER_DAY=10",
        "PAPER_TRADING=true",
        "SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XRPAUD,XDGAUD,LINKAUD",
        "TIMEFRAME=1H",
      ].join("\n") + "\n",
    );
    try { execSync("open .env"); } catch {}
    console.log("Fill in your Kraken credentials in .env then re-run: node bot.js\n");
    process.exit(0);
  }

  console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
  try { execSync("open .env"); } catch {}
  console.log("Add the missing values then re-run: node bot.js\n");
  process.exit(0);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  symbols: process.env.SYMBOLS
    ? process.env.SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean)
    : [process.env.SYMBOL || "XBTAUD"],
  timeframe: process.env.TIMEFRAME || "1H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "500"),
  maxTradeSizeAUD: parseFloat(process.env.MAX_TRADE_SIZE_AUD || "50"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "10"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  kraken: {
    apiKey: process.env.KRAKEN_API_KEY,
    apiSecret: process.env.KRAKEN_API_SECRET,
    baseUrl: "https://api.kraken.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ──────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// ─── Position Management ──────────────────────────────────────────────────────

function getPosition(log, symbol) {
  return (log.positions || []).find((p) => p.symbol === symbol) || null;
}

function addPosition(log, position) {
  if (!log.positions) log.positions = [];
  log.positions = log.positions.filter((p) => p.symbol !== position.symbol);
  log.positions.push(position);
}

function removePosition(log, symbol) {
  if (!log.positions) return;
  log.positions = log.positions.filter((p) => p.symbol !== symbol);
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter((t) => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

// ─── Kraken → Binance symbol map ──────────────────────────────────────────────

const BINANCE_SYMBOL_MAP = {
  XBTAUD:  "BTCUSDT",
  ETHAUD:  "ETHUSDT",
  SOLAUD:  "SOLUSDT",
  XRPAUD:  "XRPUSDT",
  XDGAUD:  "DOGEUSDT",
  LINKAUD: "LINKUSDT",
  SEIUSD:  "SEIUSDT",
  NEARUSD: "NEARUSDT",
  XBTUSDT: "BTCUSDT",
  XDGUSDT: "DOGEUSDT",
};

function toBinanceSymbol(s) {
  return BINANCE_SYMBOL_MAP[s] || s;
}

// ─── Kraken live price (AUD) ──────────────────────────────────────────────────

async function fetchKrakenPrice(symbol) {
  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${symbol}`);
  const data = await res.json();
  if (data.error && data.error.length > 0) throw new Error(`Kraken ticker: ${data.error.join(", ")}`);
  return parseFloat(Object.values(data.result)[0].c[0]);
}

// ─── Market Data (Binance public API — no auth needed) ────────────────────────

async function fetchCandles(symbol, interval, limit = 500) {
  const map = {
    "1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m",
    "1H":"1h","4H":"4h","1D":"1d","1W":"1w",
  };
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${map[interval]||"1h"}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  return (await res.json()).map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low:  parseFloat(k[3]),
    close: parseFloat(k[4]),
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

// Session VWAP — resets at midnight UTC
function calcVWAP(candles) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const session = candles.filter((c) => c.time >= midnight.getTime());
  if (session.length === 0) return null;
  const tpv = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol = session.reduce((s, c) => s + c.volume, 0);
  return vol === 0 ? null : tpv / vol;
}

// MACD — returns { histogram, prevHistogram } or null
function calcMACD(closes, fast = 12, slow = 26, sigPeriod = 9) {
  if (closes.length < slow + sigPeriod + 2) return null;

  // Build MACD line from bar `slow` onwards
  const macdLine = [];
  for (let end = slow; end <= closes.length; end++) {
    const s = closes.slice(0, end);
    macdLine.push(calcEMA(s, fast) - calcEMA(s, slow));
  }
  if (macdLine.length < sigPeriod + 2) return null;

  // Signal EMA of MACD line
  const mult = 2 / (sigPeriod + 1);
  let sig = macdLine.slice(0, sigPeriod).reduce((a, b) => a + b, 0) / sigPeriod;
  const sigSeries = [sig];
  for (let i = sigPeriod; i < macdLine.length; i++) {
    sig = macdLine[i] * mult + sig * (1 - mult);
    sigSeries.push(sig);
  }

  const n = sigSeries.length;
  // sigSeries[i] is seeded from macdLine[0..sigPeriod-1], so sigSeries[i] aligns with macdLine[sigPeriod-1+i]
  const histogram     = macdLine[sigPeriod - 1 + n - 1] - sigSeries[n - 1];
  const prevHistogram = macdLine[sigPeriod - 1 + n - 2] - sigSeries[n - 2];
  return { histogram, prevHistogram };
}

// Supertrend (ATR period 10, multiplier 3.0) — returns { bullish: bool } or null
function calcSupertrend(candles, period = 10, multiplier = 3.0) {
  if (candles.length < period + 2) return null;

  // Wilder's RMA for ATR
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
  // atrSeries[i] corresponds to candles[i + period]

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
    const w = rawK.slice(i - kSmooth + 1, i + 1);
    kSeries.push(w.reduce((a, b) => a + b, 0) / kSmooth);
  }

  const dSeries = [];
  for (let i = dSmooth - 1; i < kSeries.length; i++) {
    const w = kSeries.slice(i - dSmooth + 1, i + 1);
    dSeries.push(w.reduce((a, b) => a + b, 0) / dSmooth);
  }

  if (kSeries.length < 2 || dSeries.length < 2) return null;
  return {
    k:     kSeries[kSeries.length - 1],
    d:     dSeries[dSeries.length - 1],
    prevK: kSeries[kSeries.length - 2],
    prevD: dSeries[dSeries.length - 2],
  };
}

// Bollinger Bands — returns { upper, middle, lower } or null
function calcBollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const recent  = closes.slice(-period);
  const middle  = recent.reduce((a, b) => a + b, 0) / period;
  const std     = Math.sqrt(recent.reduce((s, c) => s + Math.pow(c - middle, 2), 0) / period);
  return { upper: middle + stdDev * std, middle, lower: middle - stdDev * std };
}

// ─── 5-Layer Confluence Check ─────────────────────────────────────────────────
// Returns { allPass, score, conditions, direction }

function runConfluenceCheck(price, indicators) {
  const { ema8, ema21, ema21_3ago, ema200, vwap, rsi14, rsi7, macd, supertrend, stochRsi, bb } = indicators;

  const conditions = [];
  const chk = (label, pass, detail) => {
    conditions.push({ label, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}${detail ? `  (${detail})` : ""}`);
  };

  // ── Layer 1: Binary gates — ALL must pass ─────────────────────────────
  console.log("\n── Layer 1: Gates (all must pass) ──────────────────────\n");

  const g1 = ema200 !== null && price > ema200;
  chk("Price above EMA(200) — macro regime", g1,
    `price ${price.toFixed(2)} vs EMA200 ${ema200 ? ema200.toFixed(2) : "N/A"}`);

  const g2 = vwap !== null && price > vwap;
  chk("Price above VWAP — session bias", g2,
    `price ${price.toFixed(2)} vs VWAP ${vwap ? vwap.toFixed(2) : "N/A"}`);

  const g3 = rsi14 !== null && rsi14 > 52;
  chk("RSI(14) above 52 — bullish regime", g3,
    `RSI14 = ${rsi14 ? rsi14.toFixed(1) : "N/A"}`);

  const dist = vwap ? Math.abs((price - vwap) / vwap) * 100 : 999;
  const g4   = dist < 1.5;
  chk("Price within 1.5% of VWAP — not overextended", g4, `${dist.toFixed(2)}% from VWAP`);

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
  chk("Supertrend bullish [+1]", l2b, supertrend ? (supertrend.bullish ? "Green" : "Red") : "N/A");
  if (l2b) score++;

  // ── Layer 3: Micro trigger — 2 pts ───────────────────────────────────
  console.log("\n── Layer 3: Micro Trigger (2 pts) ──────────────────────\n");

  const l3a = ema8 !== null && ema21 !== null && ema8 > ema21;
  chk("EMA(8) above EMA(21) [+1]", l3a,
    `EMA8 ${ema8 ? ema8.toFixed(4) : "N/A"} vs EMA21 ${ema21 ? ema21.toFixed(4) : "N/A"}`);
  if (l3a) score++;

  const l3b = macd !== null && macd.histogram > 0;
  chk("MACD histogram positive [+1]", l3b,
    macd ? `hist ${macd.histogram.toFixed(6)}` : "N/A");
  if (l3b) score++;

  // ── Layer 4: Entry timing — 3 pts ────────────────────────────────────
  console.log("\n── Layer 4: Entry Timing (3 pts) ───────────────────────\n");

  const l4a = rsi7 !== null && rsi7 < 30;
  chk("RSI(7) below 30 — snap-back in uptrend [+1]", l4a,
    rsi7 ? `RSI7 = ${rsi7.toFixed(1)}` : "N/A");
  if (l4a) score++;

  const l4b = stochRsi !== null
    && stochRsi.k > stochRsi.d
    && stochRsi.prevK <= stochRsi.prevD
    && stochRsi.prevK < 40;
  chk("StochRSI %K crossing above %D from oversold [+1]", l4b,
    stochRsi ? `K=${stochRsi.k.toFixed(1)} D=${stochRsi.d.toFixed(1)} prevK=${stochRsi.prevK.toFixed(1)}` : "N/A");
  if (l4b) score++;

  const l4c = bb !== null && price <= bb.lower * 1.005;
  chk("Price at/near lower Bollinger Band [+1]", l4c,
    bb ? `price ${price.toFixed(4)} vs BB lower ${bb.lower.toFixed(4)}` : "N/A");
  if (l4c) score++;

  const allPass = score >= 5;
  console.log(`\n── Confluence Score: ${score}/7 — ${allPass ? "✅ TRADE SIGNAL" : "🚫 need 5 minimum"}\n`);
  return { allPass, score, conditions, direction: "LONG" };
}

// ─── Trade Size (score-based risk %) ─────────────────────────────────────────

function calcTradeSize(score) {
  const riskPct = score >= 7 ? 0.010 : score >= 6 ? 0.0075 : 0.005;
  return Math.min(CONFIG.portfolioValue * riskPct, CONFIG.maxTradeSizeAUD);
}

// ─── Exit Conditions ──────────────────────────────────────────────────────────

function checkExitConditions(position, price, ema8, vwap) {
  const reasons = [];
  console.log("\n── Exit Check ───────────────────────────────────────────\n");
  console.log(`  Entry:       $${position.entryPrice.toFixed(4)}`);
  console.log(`  Current:     $${price.toFixed(4)}`);
  console.log(`  Stop-loss:   $${position.stopLoss.toFixed(4)}`);
  console.log(`  Take-profit: $${position.takeProfit.toFixed(4)}`);

  if (price <= position.stopLoss)   reasons.push(`Stop-loss hit (${price.toFixed(4)} ≤ ${position.stopLoss.toFixed(4)})`);
  if (price >= position.takeProfit) reasons.push(`Take-profit hit (${price.toFixed(4)} ≥ ${position.takeProfit.toFixed(4)})`);
  if (vwap && ema8 && price < vwap && price < ema8) reasons.push("Trend exit — price below VWAP and EMA8");

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

// ─── Kraken Execution ─────────────────────────────────────────────────────────

function signKraken(path, nonce, postData) {
  const secret = Buffer.from(CONFIG.kraken.apiSecret, "base64");
  const hash   = crypto.createHash("sha256").update(nonce + postData).digest("binary");
  return crypto.createHmac("sha512", secret).update(path + hash, "binary").digest("base64");
}

async function placeKrakenOrder(symbol, side, volume) {
  const path     = "/0/private/AddOrder";
  const nonce    = Date.now().toString();
  const postData = new URLSearchParams({
    nonce, pair: symbol, type: side, ordertype: "market",
    volume: parseFloat(volume).toFixed(8),
  }).toString();

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
    const note = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + note + "\n");
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
    fee     = (e.totalAUD * 0.001).toFixed(4);
    net     = (e.totalAUD - parseFloat(fee)).toFixed(2);
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
    fee     = (e.tradeSize * 0.001).toFixed(4);
    net     = (e.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = e.orderId || "";
    mode    = e.paperTrading ? "PAPER" : "LIVE";
    notes   = e.error
      ? `Error: ${e.error}`
      : `SL: ${e.stopLossAUD.toFixed(4)} | TP: ${e.takeProfitAUD.toFixed(4)} | Score: ${e.score}/7 | ATR: ${e.indicators.atr.toFixed(4)}`;
  }

  const row = [date,time,"Kraken",e.symbol,side,qty,e.price.toFixed(2),total,fee,net,orderId,mode,`"${notes}"`].join(",");
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv found."); return; }
  const rows  = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  const live  = rows.filter((r) => r[11] === "LIVE");
  const totalVol  = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((s, r) => s + parseFloat(r[8] || 0), 0);
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

async function evaluateSymbol(symbol, log) {
  console.log(`\n── ${symbol} ─────────────────────────────────────────────\n`);

  let candles;
  try {
    candles = await fetchCandles(toBinanceSymbol(symbol), CONFIG.timeframe, 500);
  } catch (err) {
    console.log(`  ⚠️  Candle fetch failed: ${err.message}`);
    return;
  }

  let audPrice;
  try {
    audPrice = await fetchKrakenPrice(symbol);
  } catch (err) {
    console.log(`  ⚠️  Kraken price fetch failed: ${err.message}`);
    return;
  }

  const closes    = candles.map((c) => c.close);
  const usdtPrice = closes[closes.length - 1];

  // Compute all indicators
  const ema8       = calcEMA(closes, 8);
  const ema21      = calcEMA(closes, 21);
  const ema200     = calcEMA(closes, 200);
  const ema21_3ago = closes.length > 3 ? calcEMA(closes.slice(0, -3), 21) : null;
  const vwap       = calcVWAP(candles);
  const rsi14      = calcRSI(closes, 14);
  const rsi7       = calcRSI(closes, 7);
  const atr        = calcATR(candles, 14);
  const macd       = calcMACD(closes);
  const supertrend = calcSupertrend(candles);
  const stochRsi   = calcStochRSI(closes);
  const bb         = calcBollingerBands(closes);

  console.log(`  Kraken (AUD):   $${audPrice.toFixed(4)}`);
  console.log(`  Binance (USDT): $${usdtPrice.toFixed(4)} — indicators only`);
  console.log(`  EMA(8):    $${ema8    ? ema8.toFixed(4)    : "N/A"}`);
  console.log(`  EMA(21):   $${ema21   ? ema21.toFixed(4)   : "N/A"}`);
  console.log(`  EMA(200):  $${ema200  ? ema200.toFixed(4)  : "N/A"}`);
  console.log(`  VWAP:      ${vwap     ? "$" + vwap.toFixed(4) : "N/A"}`);
  console.log(`  RSI(14):   ${rsi14    ? rsi14.toFixed(1)   : "N/A"}`);
  console.log(`  RSI(7):    ${rsi7     ? rsi7.toFixed(1)    : "N/A"}`);
  console.log(`  ATR(14):   $${atr     ? atr.toFixed(4)     : "N/A"}`);
  console.log(`  MACD hist: ${macd     ? macd.histogram.toFixed(6) : "N/A"}`);
  console.log(`  Supertrend: ${supertrend ? (supertrend.bullish ? "Bullish ▲" : "Bearish ▼") : "N/A"}`);
  console.log(`  StochRSI K/D: ${stochRsi ? stochRsi.k.toFixed(1) + "/" + stochRsi.d.toFixed(1) : "N/A"}`);
  console.log(`  BB lower:  ${bb       ? "$" + bb.lower.toFixed(4) : "N/A"}`);

  if (!atr || !vwap) {
    console.log("  ⚠️  Insufficient data. Skipping.");
    return;
  }

  // ── EXIT: check open position first ──────────────────────────────────
  const position = getPosition(log, symbol);
  if (position) {
    const { shouldExit, reasons } = checkExitConditions(position, usdtPrice, ema8, vwap);
    if (!shouldExit) return;

    const totalAUD = position.quantity * audPrice;
    const pnl      = (audPrice - position.entryPriceAUD) * position.quantity;
    const logEntry = {
      timestamp: new Date().toISOString(), symbol, side: "sell",
      price: audPrice, quantity: position.quantity, totalAUD, pnl,
      exitReasons: reasons, orderPlaced: false, orderId: null,
      paperTrading: CONFIG.paperTrading,
    };

    console.log("\n── Decision ─────────────────────────────────────────────\n");

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER SELL — ${symbol} qty ${position.quantity} ~$${totalAUD.toFixed(2)} AUD`);
      console.log(`   P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} AUD`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING SELL ORDER — ${position.quantity} ${symbol} (~$${totalAUD.toFixed(2)} AUD)`);
      try {
        const order = await placeKrakenOrder(symbol, "sell", position.quantity);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ SELL ORDER PLACED — ${order.orderId} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} AUD`);
      } catch (err) {
        console.log(`❌ SELL ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    if (logEntry.orderPlaced) removePosition(log, symbol);
    log.trades.push(logEntry);
    writeTradeCsv(logEntry);
    return;
  }

  // ── ENTRY: 5-layer confluence check ──────────────────────────────────
  const { allPass, score, conditions } = runConfluenceCheck(usdtPrice, {
    ema8, ema21, ema21_3ago, ema200, vwap, rsi14, rsi7, macd, supertrend, stochRsi, bb,
  });

  const tradeSize    = calcTradeSize(score);
  const quantity     = tradeSize / audPrice;
  const atrPct       = atr / usdtPrice;
  const stopLoss     = usdtPrice - atr * 1.5;
  const takeProfit   = usdtPrice + atr * 2.5;
  const stopLossAUD  = audPrice * (1 - atrPct * 1.5);
  const takeProfitAUD = audPrice * (1 + atrPct * 2.5);

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(), symbol, side: "buy",
    timeframe: CONFIG.timeframe, price: audPrice,
    indicators: { ema8, ema21, ema200, vwap, rsi14, rsi7, atr },
    conditions, allPass, score, tradeSize, quantity,
    stopLoss, takeProfit, stopLossAUD, takeProfitAUD,
    orderPlaced: false, orderId: null, paperTrading: CONFIG.paperTrading,
  };

  if (!allPass) {
    const failed = conditions.filter((r) => !r.pass).map((r) => r.label);
    console.log("🚫 TRADE BLOCKED");
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    const riskLabel = score >= 7 ? "1.0%" : score >= 6 ? "0.75%" : "0.5%";
    console.log(`✅ ALL CONDITIONS MET — Score: ${score}/7 (${riskLabel} risk)`);
    console.log(`   Trade size:  $${tradeSize.toFixed(2)} AUD`);
    console.log(`   Stop-loss:   $${stopLossAUD.toFixed(4)} AUD (1.5× ATR)`);
    console.log(`   Take-profit: $${takeProfitAUD.toFixed(4)} AUD (2.5× ATR)`);

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — ${symbol} qty ${quantity.toFixed(8)} ~$${tradeSize.toFixed(2)} AUD @ $${audPrice.toFixed(4)}`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING BUY ORDER — ${quantity.toFixed(8)} ${symbol} (~$${tradeSize.toFixed(2)} AUD @ $${audPrice.toFixed(4)} AUD)`);
      try {
        const order = await placeKrakenOrder(symbol, "buy", quantity);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ BUY ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ BUY ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    if (logEntry.orderPlaced) {
      addPosition(log, {
        symbol,
        entryPrice:    usdtPrice,
        entryPriceAUD: audPrice,
        quantity,
        entryTime:     logEntry.timestamp,
        orderId:       logEntry.orderId,
        stopLoss,
        takeProfit,
        atrAtEntry:    atr,
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
  console.log("  Claude Trading Bot — Blended Confluence Scalper v2.0");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbols (${CONFIG.symbols.length}): ${CONFIG.symbols.join(", ")} | Timeframe: ${CONFIG.timeframe}`);
  console.log(`Min confluence: 5/7 | Risk: 0.5% (5/7) → 0.75% (6/7) → 1.0% (7/7)`);

  const log = loadLog();

  for (const symbol of CONFIG.symbols) {
    const withinLimits = checkTradeLimits(log);
    if (!withinLimits) {
      console.log("\nBot stopping — daily trade limit reached.");
      break;
    }
    await evaluateSymbol(symbol, log);
  }

  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
