/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["KRAKEN_API_KEY", "KRAKEN_API_SECRET"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# Kraken credentials",
        "KRAKEN_API_KEY=",
        "KRAKEN_API_SECRET=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOLS=XBTUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,XDGUSDT,LINKUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your Kraken credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbols: process.env.SYMBOLS
    ? process.env.SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean)
    : [process.env.SYMBOL || "BTCUSDT"],
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeAUD: parseFloat(process.env.MAX_TRADE_SIZE_AUD || process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  kraken: {
    apiKey: process.env.KRAKEN_API_KEY,
    apiSecret: process.env.KRAKEN_API_SECRET,
    baseUrl: "https://api.kraken.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// ─── Position Management ─────────────────────────────────────────────────────

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
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Kraken → Binance symbol map (candle data comes from Binance public API) ──
// Kraken uses different naming (XBT, XDG) and AUD pairs; Binance uses USDT.

const BINANCE_SYMBOL_MAP = {
  XBTAUD:  "BTCUSDT",
  ETHAUD:  "ETHUSDT",
  SOLAUD:  "SOLUSDT",
  XRPAUD:  "XRPUSDT",
  XDGAUD:  "DOGEUSDT",
  LINKAUD: "LINKUSDT",
  // USDT pairs kept as fallback
  XBTUSDT:  "BTCUSDT",
  XDGUSDT:  "DOGEUSDT",
};

function toBinanceSymbol(krakenSymbol) {
  return BINANCE_SYMBOL_MAP[krakenSymbol] || krakenSymbol;
}

// ─── Kraken live price (AUD) — used for order sizing and P&L ────────────────

async function fetchKrakenPrice(symbol) {
  const res = await fetch(
    `https://api.kraken.com/0/public/Ticker?pair=${symbol}`
  );
  const data = await res.json();
  if (data.error && data.error.length > 0) {
    throw new Error(`Kraken ticker error: ${data.error.join(", ")}`);
  }
  const ticker = Object.values(data.result)[0];
  return parseFloat(ticker.c[0]); // last trade close price
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Map our timeframe format to Binance interval format
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();

  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias first
  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    // 1. Price above VWAP
    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    // 2. Price above EMA(8)
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    // 3. RSI(3) pullback
    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );

    // 4. Not overextended from VWAP
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );

    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Exit Conditions ─────────────────────────────────────────────────────────

function checkExitConditions(position, price, ema8, vwap) {
  const reasons = [];

  console.log("\n── Exit Check ───────────────────────────────────────────\n");
  console.log(`  Entry:       $${position.entryPrice.toFixed(4)}`);
  console.log(`  Current:     $${price.toFixed(4)}`);
  console.log(`  Stop-loss:   $${position.stopLoss.toFixed(4)}`);
  console.log(`  Take-profit: $${position.takeProfit.toFixed(4)}`);

  if (price <= position.stopLoss) {
    reasons.push(`Stop-loss hit (${price.toFixed(4)} ≤ ${position.stopLoss.toFixed(4)})`);
  }
  if (price >= position.takeProfit) {
    reasons.push(`Take-profit hit (${price.toFixed(4)} ≥ ${position.takeProfit.toFixed(4)})`);
  }
  if (price < vwap && price < ema8) {
    reasons.push(`Trend exit — bearish flip (price below VWAP and EMA8)`);
  }

  if (reasons.length === 0) {
    console.log(`  📊 Holding — no exit condition triggered`);
  } else {
    reasons.forEach((r) => console.log(`  🚨 ${r}`));
  }

  return { shouldExit: reasons.length > 0, reasons };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeAUD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} AUD exceeds max $${CONFIG.maxTradeSizeAUD} AUD`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} AUD — within max $${CONFIG.maxTradeSizeAUD} AUD`,
  );

  return true;
}

// ─── Kraken Execution ────────────────────────────────────────────────────────

function signKraken(path, nonce, postData) {
  const secret = Buffer.from(CONFIG.kraken.apiSecret, "base64");
  const hash = crypto.createHash("sha256").update(nonce + postData).digest("binary");
  return crypto.createHmac("sha512", secret).update(path + hash, "binary").digest("base64");
}

async function placeKrakenOrder(symbol, side, volume) {
  const path = "/0/private/AddOrder";
  const nonce = Date.now().toString();
  const postData = new URLSearchParams({
    nonce,
    pair: symbol,
    type: side,
    ordertype: "market",
    volume: parseFloat(volume).toFixed(8),
  }).toString();

  const signature = signKraken(path, nonce, postData);

  const res = await fetch(`${CONFIG.kraken.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "API-Key": CONFIG.kraken.apiKey,
      "API-Sign": signature,
    },
    body: postData,
  });

  const data = await res.json();
  if (data.error && data.error.length > 0) {
    throw new Error(`Kraken order failed: ${data.error.join(", ")}`);
  }

  return { orderId: data.result.txid[0] };
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (logEntry.side === "sell") {
    side = "SELL";
    quantity = logEntry.quantity.toFixed(8);
    totalUSD = logEntry.totalAUD.toFixed(2);
    fee = (logEntry.totalAUD * 0.001).toFixed(4);
    netAmount = (logEntry.totalAUD - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = logEntry.paperTrading ? "PAPER" : "LIVE";
    const pnlStr = `${logEntry.pnl >= 0 ? "+" : ""}${logEntry.pnl.toFixed(2)} AUD`;
    notes = logEntry.error
      ? `Error: ${logEntry.error}`
      : `P&L: ${pnlStr} | ${logEntry.exitReasons.join("; ")}`;
  } else if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else {
    side = "BUY";
    quantity = logEntry.quantity.toFixed(8);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = logEntry.paperTrading ? "PAPER" : "LIVE";
    notes = logEntry.error
      ? `Error: ${logEntry.error}`
      : `SL: ${logEntry.stopLoss.toFixed(4)} | TP: ${logEntry.takeProfit.toFixed(4)} | ATR: ${logEntry.indicators.atr.toFixed(4)}`;
  }

  const row = [
    date,
    time,
    "Kraken",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Per-symbol evaluation ───────────────────────────────────────────────────

async function evaluateSymbol(symbol, log, rules) {
  console.log(`\n── ${symbol} ─────────────────────────────────────────────\n`);

  // Fetch candle data from Binance (indicators — currency-agnostic signals)
  let candles;
  try {
    candles = await fetchCandles(toBinanceSymbol(symbol), CONFIG.timeframe, 500);
  } catch (err) {
    console.log(`  ⚠️  Failed to fetch candle data for ${symbol}: ${err.message}`);
    return;
  }

  // Fetch live AUD price from Kraken — used for order sizing and P&L only
  let audPrice;
  try {
    audPrice = await fetchKrakenPrice(symbol);
  } catch (err) {
    console.log(`  ⚠️  Failed to fetch Kraken AUD price for ${symbol}: ${err.message}`);
    return;
  }

  const closes = candles.map((c) => c.close);
  const usdtPrice = closes[closes.length - 1]; // used for indicator signals only

  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);
  const atr  = calcATR(candles, 14);

  console.log(`  Kraken price (AUD): $${audPrice.toFixed(4)}`);
  console.log(`  Binance price (USDT): $${usdtPrice.toFixed(4)} — used for indicators only`);
  console.log(`  EMA(8):  $${ema8.toFixed(4)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(4) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);
  console.log(`  ATR(14): $${atr ? atr.toFixed(4) : "N/A"}`);

  if (!vwap || !rsi3 || !atr) {
    console.log(`  ⚠️  Not enough data to calculate indicators. Skipping.`);
    return;
  }

  // ── EXIT: check open position first ───────────────────────────────────────
  const position = getPosition(log, symbol);

  if (position) {
    const { shouldExit, reasons } = checkExitConditions(position, usdtPrice, ema8, vwap);

    if (!shouldExit) return null;

    // Close the position — P&L in AUD using Kraken live price
    const totalAUD = position.quantity * audPrice;
    const pnl = (audPrice - position.entryPriceAUD) * position.quantity;
    const logEntry = {
      timestamp: new Date().toISOString(),
      symbol,
      side: "sell",
      price,
      quantity: position.quantity,
      totalAUD,
      pnl,
      exitReasons: reasons,
      orderPlaced: false,
      orderId: null,
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
    return logEntry;
  }

  // ── ENTRY: no open position — check buy conditions ────────────────────────
  const { results, allPass } = runSafetyCheck(usdtPrice, ema8, vwap, rsi3, rules);

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeAUD);
  const quantity = tradeSize / audPrice; // volume sized in AUD

  // ATR-based stops use USDT ATR as a % of price, applied to AUD price
  const atrPct     = atr / usdtPrice;
  const stopLoss   = usdtPrice - atr * 1.5;       // USDT — for signal comparison
  const takeProfit = usdtPrice + atr * 2.5;       // USDT — for signal comparison
  const stopLossAUD   = audPrice * (1 - atrPct * 1.5);  // AUD — for logging
  const takeProfitAUD = audPrice * (1 + atrPct * 2.5);  // AUD — for logging

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol,
    side: "buy",
    timeframe: CONFIG.timeframe,
    price: audPrice,
    indicators: { ema8, vwap, rsi3, atr },
    conditions: results,
    allPass,
    tradeSize,
    quantity,
    stopLoss,
    takeProfit,
    stopLossAUD,
    takeProfitAUD,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);
    console.log(`   Stop-loss:   $${stopLossAUD.toFixed(4)} AUD (1.5× ATR)`);
    console.log(`   Take-profit: $${takeProfitAUD.toFixed(4)} AUD (2.5× ATR)`);

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — would buy ${symbol} qty ${quantity.toFixed(8)} ~$${tradeSize.toFixed(2)} AUD @ $${audPrice.toFixed(4)} AUD`);
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
        entryPrice: usdtPrice,    // USDT — for indicator-based exit signals
        entryPriceAUD: audPrice,  // AUD  — for P&L calculation
        quantity,
        entryTime: logEntry.timestamp,
        orderId: logEntry.orderId,
        stopLoss,
        takeProfit,
        atrAtEntry: atr,
      });
    }
  }

  log.trades.push(logEntry);
  writeTradeCsv(logEntry);
  return logEntry;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbols (${CONFIG.symbols.length}): ${CONFIG.symbols.join(", ")} | Timeframe: ${CONFIG.timeframe}`);

  const log = loadLog();

  for (const symbol of CONFIG.symbols) {
    // Re-check limits before each symbol — stop as soon as daily cap is hit
    const withinLimits = checkTradeLimits(log);
    if (!withinLimits) {
      console.log("\nBot stopping — trade limits reached for today.");
      break;
    }

    await evaluateSymbol(symbol, log, rules);
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
