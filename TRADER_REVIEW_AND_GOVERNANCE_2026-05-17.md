# Trader review — 2026-05-17

> Written as if I'm running your book. I've sat with the Kraken export, your Supabase trade log, your `rules.json`, and your `bot.js`. This is not an audit. This is what I'd tell my own desk if these were our numbers.

---

## The verdict

You don't have a losing strategy. You have a **fee-bleeding rotation engine** with no risk-on / risk-off discipline. Over 30 days the bot turned a respectable indicator stack into −AUD 63 on 11.8 % WR — and AUD 60 of that loss is fees. That's not a trader losing money in the market. That's a trader losing money to the exchange. We have to stop the fee bleed first, then we can talk returns.

The good news, and it's actually good: your **Score 6 bucket is profitable** (+AUD 6.59 LIVE+PAPER combined, 57 % WR). Every take-profit hit was profitable (+AUD 24.86 across 12 trades). The signal is real. It's drowning in entries below your edge threshold and exits that fire before the edge expresses.

So three things stop now, three things start now, and one belief gets killed.

---

## Governance — the rules I'd actually trade by

These are not "safety rails". These are the rules that separate the desk that ends the month up from the desk that ends the month flat. Every one of these is a Supabase row update or a small bot.js patch.

### 1. Edge gate — only trade the bucket that pays

Your data says Score 6 makes money, Score 5 loses, Score 4 is flat, Score 7 is too small a sample. From now: **minimum entry score is 6**. No exceptions, no overrides. When the bot fires fewer trades because of this, that is the rule working — not failing.

### 2. Daily profit lock

Most retail bots have a daily *loss* limit (yours is −3 %). They have no daily *profit* lock. That's how a +1.5 % day becomes a 0 % day. New rule: **once a day's realised P&L hits +1.5 %, the bot stops opening new positions for that calendar day**. Existing positions still get managed. Sleep on the win.

### 3. Three-strikes circuit breaker

**Three consecutive losers across any symbol = bot halts new entries for the next 4 hours.** Forces a tape re-read. The bot has no concept of "the regime changed mid-day" — this is the cheapest proxy for it. Stored in `bot_state` as `circuit_breaker_until` timestamp.

### 4. Equity-peak drawdown halt

Track 30-day equity peak in `bot_state`. If realised account equity drops 5 % from peak, **halt all new entries for 24 hours and post to Telegram**. The Telegram debrief already exists — extend it. This is the single rule that prevents catastrophic monthly losses. Every quant desk has a version of it.

### 5. Killswitch

A single row in `bot_state` with `key = 'killswitch'` and `value = 'true'` stops the bot from opening or closing anything. You can hit it from your phone via Supabase mobile. Every algo I've ever run has had one. The day you need it and don't have it is the day you blow up.

### 6. News blackout windows

Hardcode FOMC days, CPI release windows (12:30–14:00 UTC on data day), and the Sunday 22:00–02:00 UTC window (weekend liquidity hole). Skip new entries in those windows. Exits run normally. These are the windows where the indicator stack gets steamrolled by macro flow it can't see.

### 7. Weekly Supabase recalibration

Every Sunday 22:00 UTC, run a query against `v_perf_by_score` and `v_perf_by_symbol`. If any score bucket has 10+ trades and negative expectancy, **automatically raise the minimum score by 1**. If any symbol has 10+ trades and negative expectancy over the rolling 14 days, **drop it from `SYMBOLS`** and Telegram the change. This is governance that compounds — the bot gets better while you sleep.

### 8. Position-level accountability log

Every entry writes a `rationale` field to `bot_trades` containing the indicator state snapshot. After 30 days you have 200+ labelled examples. Feed them to Claude weekly and ask "which conditions cluster in the losers?" That's how a desk evolves — not by re-reading textbooks, by re-reading its own trades.

### 9. No live trading on a new rule for 14 days

Any change to `rules.json` or scoring logic runs `PAPER_TRADING=true` for 14 calendar days before going live. No exceptions. Backtests lie; paper-on-current-tape doesn't.

### 10. Risk budget, not trade size

Replace the `MAX_TRADE_SIZE_AUD` / `MIN_TRADE_SIZE_AUD` clamp with a **daily risk budget**: 2 % of portfolio = max total dollars at risk across all open positions at any time. The bot solves position size to honour that budget. When budget is full, no new entries. This actually expresses your risk preference, unlike the current min/max which silently force every trade to the same size regardless of conviction.

---

## The frequency question — answered hard

You asked: should we reduce time between coin reviews and trade executions. Does rapid execution help daily wins?

**Direct answer: no. Faster makes you worse, not better. Your data already proves this.**

Here is the math:

- Your Kraken round-trip fee is roughly 0.42 % (0.16 % maker + 0.26 % taker).
- Your average winner is +AUD 0.82.
- Fees on an AUD 100 trade are AUD 0.42 — that is **51 % of the average winner**, gone before signal vs noise even matters.
- Median hold is 3.9 hours. The bot is already exiting too fast.
- 1H cron already gives you 24 decision points per day across 4 symbols = up to 96 potential decisions/day.

If you drop to 15-minute cron, you get 4× the decisions, 4× the fee drag, and 4× the false signals from noisier candles. That's not faster wins. That's amplified bleed.

**Faster only helps when one of these is true:**
- You have maker-rebate fee tier (Kraken needs >$10M monthly volume — not us).
- You're running market-making, not directional trading (different game entirely).
- You're trading event flow at sub-second latency (LLM + Railway cron can't do this).
- Spreads are tight enough that round-trip cost < 0.05 % (it isn't on Kraken AUD pairs).

**For your bot, the right direction is the opposite — slow down.** Specifically:

- Entries gate to **4-hour boundaries** (UTC 00, 04, 08, 12, 16, 20). Already in your Tier 1 prompt.
- Exits stay hourly. Exits need responsiveness because that's where stops live.
- Once Tier 1 has run paper for 2 weeks and you're at PF > 1.2, try moving entries to **6-hour boundaries**. Test it in paper for another fortnight. Compare PF.
- The signal stack you have (EMA / VWAP / RSI / Supertrend / MACD / BB) is *meant* for the 4H–1D timeframe. You've been running it on 1H, which is signal-light and noise-heavy.

Daily incremental wins are not produced by trading more. They're produced by **trading the same regime more accurately**. Same trader, lower frequency, higher selectivity = more dollars at end-of-month. Every credible 2026 retrospective on retail bots says the same thing: over 80 % of retail bot users underperform buy-and-hold *because of overtrading*.

If you want incremental wins, the daily-profit-lock and three-strikes circuit breaker from the governance section above will do more for your equity curve than any cron change.

---

## 10 + coins on Kraken seeing real success

Filtered for: actually trading on Kraken (spot or margin pair), recent strength backed by either flow or narrative, and **enough liquidity that you can size in and out without eating spread**. Ranked roughly by my conviction for a 1H–4H momentum bot in current conditions.

| Rank | Symbol | Kraken pair | Why it's hot in May 2026 | Risk note |
|---|---|---|---|---|
| 1 | **SOL** | SOLAUD / SOLUSD | +180 % YTD, strongest large-cap performer, clean trends | Already in your watchlist — increase size on it |
| 2 | **HYPE** | HYPEUSD | +68–76 % YTD, Bitwise just launched a spot HYPE ETF, leading gainer post-listing | Volatile; respect the trail |
| 3 | **TRX** | TRXUSD | +7 % in May, 8-month high, record stablecoin volume on Tron — real demand, low-vol uptrend | The "boring trade" — perfect for your stack |
| 4 | **TAO** | TAOUSD | +87 % in the last 30 days despite recent 7-day pullback, leading the AI-coin sector | Wait for higher low before adding |
| 5 | **VVV** | VVVUSD | +300 % YTD, top-200 best performer of 2026 | Smaller cap — keep size conservative |
| 6 | **FET** | FETUSD | +60 % last month, AI narrative beneficiary | Pair-correlates with TAO, don't hold both at max bucket |
| 7 | **RENDER** | RENDERUSD | +31 % last month, AI / GPU compute narrative | Liquid on Kraken, clean structure |
| 8 | **BNB** | BNBUSD | +6 % last week, Kraken IPO halo + BNB rally feeding off Binance volume | More measured; trend follower's friend |
| 9 | **ADA** | ADAAUD / ADAUSD | +5 % last Thursday, blue-chip catching late-cycle rotation flows | Was on your drop list — re-add only if it breaks 30-day high |
| 10 | **WIF** | WIFUSD | dogwifhat, top-20 Kraken volume — paired with DOGE this remains the memecoin volatility sleeve | High vol; only hold if budget allows |
| 11 | **BONK** | BONKUSD | Kraken added margin pair, memecoin rotation in Solana ecosystem | High vol; alternative meme exposure if WIF drops |
| 12 | **DOGE** | XDGAUD | +4.75 % recent, leading memes, your only meme already showing TP-hit pattern in Supabase | Keep — it's already in |

**My picks if you can only add 4 of these to the current Tier 1 watchlist:**

```
HYPEUSD, TRXUSD, TAOUSD, FETUSD
```

Why these four: HYPE = institutional flow leader. TRX = low-vol uptrend, exactly the shape your confluence rules grade highest. TAO = AI sector leader with monthly +87 % even after the dip. FET = highest-momentum AI alt that's NOT TAO, gives you AI-sector exposure without single-coin concentration.

Hold off VVV, RENDER, ADA, BNB until Tier 1 + the new BTC-dominance gate have produced 2 weeks of positive PF. They're real, they're just not first-wave additions.

---

## The belief we kill today

> "More trades per day = more chances to profit."

This was true in 2017. It's false in 2026 with a 0.42 % round-trip fee structure, retail-tier liquidity, and 1H candles. **Selectivity is the alpha now.** Your Score 6 bucket making money while Score 5 loses is the same lesson in your own data. Trade less, trade better, size up on the trades that fit the bucket that's proven.

---

## Paste this into your Claude Code terminal

This composes on top of the Tier 1 prompt and the 2026-05-17 watchlist prompt. Paste it after those have run.

---

You are working in the `claude-tradingview-mcp-trading` repo. Apply the governance layer and the new watchlist additions. Do not touch the score / exit / sizing logic — Tier 1 already handled that. Print before/after diffs per change. Run `node bot.js` once in paper mode at the end.

### Change 1 — Daily profit lock

In `bot.js`, alongside `checkDailyLossLimit()`, add `checkDailyProfitLock()`:

```js
async function checkDailyProfitLock() {
  if (!supabaseReady()) return { locked: false, dailyPnl: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const modeFilter = CONFIG.paperTrading ? "PAPER" : "LIVE";
  const data = await supabaseSelect(
    "bot_trades",
    `timestamp=gte.${today}T00:00:00Z&side=eq.sell&mode=eq.${modeFilter}`,
    "pnl"
  );
  if (!data) return { locked: false, dailyPnl: 0 };
  const dailyPnl = data.reduce((s, r) => s + (parseFloat(r.pnl) || 0), 0);
  const target = CONFIG.portfolioValue * 0.015; // +1.5 % daily target
  return { locked: dailyPnl >= target, dailyPnl };
}
```

In `checkTradeLimits()`, call it. If `locked` is true, log `🔒 Daily profit lock — +X.XX AUD already today, no new entries until tomorrow UTC.` and return `false`.

### Change 2 — Three-strikes circuit breaker

Persist a `circuit_breaker_until` row in `bot_state`. In `checkTradeLimits()`, before any other check:

```js
const cbRow = await supabaseSelect("bot_state", "key=eq.circuit_breaker_until", "value");
const cbUntil = cbRow?.[0]?.value ? new Date(cbRow[0].value) : null;
if (cbUntil && cbUntil > new Date()) {
  console.log(`⛔ Circuit breaker active until ${cbUntil.toISOString()} — entries blocked`);
  return false;
}
```

When recording a sell in `evaluateSymbol()`, query the last 3 closed trades for the same mode:

```js
const last3 = await supabaseSelect(
  "bot_trades",
  `side=eq.sell&mode=eq.${CONFIG.paperTrading ? "PAPER" : "LIVE"}&order=timestamp.desc&limit=3`,
  "pnl"
);
if (last3 && last3.length === 3 && last3.every(t => parseFloat(t.pnl) < 0)) {
  const until = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
  await supabaseUpsert("bot_state", { key: "circuit_breaker_until", value: until, updated_at: new Date().toISOString() }, "key");
  console.log(`⛔ Three losers in a row — circuit breaker engaged until ${until}`);
}
```

### Change 3 — Killswitch

In `run()`, before anything else after the banner:

```js
const ks = await supabaseSelect("bot_state", "key=eq.killswitch", "value");
if (ks?.[0]?.value === "true") {
  console.log("☠️ Killswitch ENGAGED in Supabase — exiting without doing anything");
  return;
}
```

Document in `README.md` (one paragraph): to halt the bot from anywhere, set `bot_state.killswitch = "true"` in Supabase. To resume, set it back to `"false"` or delete the row.

### Change 4 — Equity-peak drawdown halt

In `run()`, after the killswitch check, compute the realised equity peak from `bot_trades` over the last 30 days. Store as `equity_peak` in `bot_state`. If realised equity (sum of all sell PnL over 30 days) drops 5 % below peak, set `circuit_breaker_until` to 24 hours from now and Telegram-post the event using the existing `sendTelegram` helper imported from `debrief.js`.

### Change 5 — News blackout windows

Add a hardcoded JS array of UTC datetime ranges to skip. Format `[ [startISO, endISO, label], ... ]`. Include the next 30 days of FOMC, CPI, NFP windows (12:30 – 14:00 UTC on release days — look these up and seed the array). Also skip Sunday 22:00 UTC → Monday 02:00 UTC every week (weekend liquidity hole). In `evaluateSymbol`, before the entry section, return early if `now` falls inside any active window. Log the window label.

### Change 6 — Phase 2 watchlist additions (HYPE, TRX, TAO, FET)

Update `.env`:

```
SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XDGAUD,HYPEUSD,TRXUSD,TAOUSD,FETUSD
```

Also run `railway variables set SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XDGAUD,HYPEUSD,TRXUSD,TAOUSD,FETUSD`.

Extend the symbol maps in `bot.js`:

```js
// BINANCE_SYMBOL_MAP
HYPEUSD: "HYPEUSDT",
TRXUSD:  "TRXUSDT",
TAOUSD:  "TAOUSDT",
FETUSD:  "FETUSDT",

// KRAKEN_BASE
HYPEUSD: "HYPE",
TRXUSD:  "TRX",
TAOUSD:  "TAO",
FETUSD:  "FET",

// KRAKEN_PAIR_PATTERN
HYPEUSD: "HYPE",
TRXUSD:  "TRX",
TAOUSD:  "TAO",
FETUSD:  "FET",

// QUOTE_CURRENCY
HYPEUSD: "USD",
TRXUSD:  "USD",
TAOUSD:  "USD",
FETUSD:  "USD",

// KRAKEN_MIN_ORDER (verify on first live use)
HYPEUSD: 0.2,
TRXUSD:  20,
TAOUSD:  0.05,
FETUSD:  10,
```

Replace the `BUCKETS` block:

```js
const BUCKETS = {
  BTC_BETA:    ["XBTAUD", "ETHAUD", "SOLAUD"],
  AI_NARR:     ["TAOUSD", "FETUSD"],
  TREND_LEAD:  ["HYPEUSD", "TRXUSD"],
  MEMES:       ["XDGAUD"],
};
```

`MAX_PER_BUCKET = 2` is fine. With 4 buckets the bot can hold 8 positions max, which matches your portfolio.

### Change 7 — Weekly Supabase recalibration cron

Add a new file `recalibrate.js`. It runs on Sunday 22:00 UTC (Railway cron `0 22 * * 0`). Logic:

1. Pull `v_perf_by_score` for the last 14 days.
2. For each score with `trades >= 10 AND total_pnl < 0`: bump `bot_state.min_confluence_score` by 1 (capped at 8) and Telegram the change.
3. Pull `v_perf_by_symbol` for the last 14 days.
4. For each symbol with `trades >= 10 AND total_pnl < 0`: read current `SYMBOLS` from env, remove that symbol, write back via Railway API (or log the recommendation if Railway API key not present), Telegram the change.
5. Read current `min_confluence_score` from `bot_state` at the top of `runConfluenceCheck()` — if present, use it instead of the hardcoded 6.

### Change 8 — Risk budget replaces min/max trade size

In `calcTradeSize`, replace the clamp logic. New behaviour:

```js
async function calcTradeSize(score, atrPct) {
  const riskPct = score >= 7 ? 0.010 : 0.005;
  const dailyRiskBudgetAUD = CONFIG.portfolioValue * 0.02;

  // How much risk is already deployed in open positions today?
  const open = await supabaseSelect("bot_positions", "is_open=eq.true", "entry_price_aud,stop_loss_usdt,quantity");
  const deployedRisk = (open || []).reduce((s, p) => {
    const entry = parseFloat(p.entry_price_aud);
    const stop  = parseFloat(p.stop_loss_usdt); // approximate; uses USDT but same proportional
    const qty   = parseFloat(p.quantity);
    return s + Math.abs((entry - stop) * qty);
  }, 0);

  const remaining = dailyRiskBudgetAUD - deployedRisk;
  if (remaining <= 0) return 0; // no budget left

  const trialRisk = CONFIG.portfolioValue * riskPct;
  const useRisk   = Math.min(trialRisk, remaining);
  const stopPct   = atrPct * 1.5;
  return stopPct > 0 ? useRisk / stopPct : 0;
}
```

If `calcTradeSize` returns 0, treat as a blocked entry with reason `Daily risk budget exhausted`.

### Change 9 — Rationale logged on every entry

In `evaluateSymbol`, when writing to `bot_trades` on the buy branch, add a new column `rationale` with JSON containing: `{ema8, ema21, ema200, vwap, rsi14, rsi7, adx, macd_hist, supertrend, score, atr_pct, btc_d, fear_greed}`. If the column doesn't exist in Supabase yet, add it via SQL: `ALTER TABLE public.bot_trades ADD COLUMN IF NOT EXISTS rationale jsonb;`.

### After applying

1. Print all diffs.
2. Run `node bot.js` once in paper mode.
3. Verify in output: killswitch check log, equity-peak check log, profit-lock check log, circuit-breaker check log, watchlist of 8 symbols, blackout window check log, rationale being written.
4. Commit on branch `governance-and-phase2-additions`. Do not push.

Stop and report. Do not advance past these changes. I'll review the paper output and the Supabase rows before we go live.
