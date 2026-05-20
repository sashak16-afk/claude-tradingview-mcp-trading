# Tier 1 — paste this whole file into Claude Code

Open Claude Code inside `claude-tradingview-mcp-trading/` and paste everything below the line. Claude will read the file, apply the seven Tier 1 changes to `bot.js` and `.env`, show you a diff, and run the bot once in paper mode so you can verify.

The data behind these decisions (your Supabase + Kraken export, 30 days): win rate 11.8 %, profit factor 0.11, fees are 95 % of net loss, trailing stops cause ~75 % of losses, every take-profit hit was profitable. Fix the structural geometry first; everything else is downstream.

---

You are working in this repo. Your job is to apply seven specific changes to `bot.js` and `.env` in one pass, then run the bot once in paper mode and show me the output. Do not refactor anything I do not ask you to refactor. Do not change the indicators. Do not touch `rules.json`. After each change, print the before/after diff for the lines you changed.

## Change 1 — Exit with post-only limit orders, not market orders

In `bot.js`, the function `placeKrakenOrder(symbol, side, volume, limitPrice = null)` builds a Kraken `AddOrder` request. Right now sells go through it with no `limitPrice`, so they execute as market orders and pay the 0.26 % taker fee.

Modify `placeKrakenOrder` so that when `side === "sell"` AND `limitPrice` is not provided, the function:

1. Fetches the current `bid` via `fetchKrakenTicker(symbol)`.
2. Builds a limit sell at that bid with `ordertype: "limit"` and adds `oflags: "post"` to the params (Kraken's post-only flag — order is cancelled if it would cross the spread).
3. Sets a Kraken expiry: add `expiretm: "+1800"` (30 minutes in seconds, relative — Kraken accepts this). If unfilled in 30 minutes Kraken cancels it automatically and the next hourly run's `cancelStaleOrders`-style check will sweep up.
4. Keeps the existing market-buy and explicit-limit-buy paths unchanged.

Then in `evaluateSymbol` where the exit branch calls `placeKrakenOrder(symbol, "sell", position.quantity)`, leave the call site alone — the new logic lives inside `placeKrakenOrder`. Just add a console log on the new path: `console.log("  📉 Post-only limit sell @ bid $X.XXXX (30m expiry, market fallback next run)")`.

Also extend `cancelStaleOrders()` to cancel stale **sell** limits older than 2 hours (currently only buys). Same logic, drop the `order.descr?.type === "buy"` filter or add an OR for `"sell"`. After it cancels a stale sell limit, place a market sell as the fallback so the position closes — fetch `getOpenPosition(symbol)` to recover the quantity.

Acceptance: on the next paper run, every sell goes out as `ordertype: limit` with `oflags: post`. Buys are unchanged.

## Change 2 — Raise minimum confluence score from 4/8 to 6/8

In `bot.js`, `runConfluenceCheck()` — last line currently reads `const allPass = score >= 4;`. Change to `score >= 6`.

In `rules.json`, update `minimum_confluence.required_score` from `"4 out of 8 scored points (Layers 2+3+4)"` to `"6 out of 8 scored points (Layers 2+3+4)"` so it stays consistent.

In `calcTradeSize(score, atrPct)`, the risk tiers are currently `7+ → 1.0%`, `6 → 0.75%`, `<6 → 0.5%`. Since the new minimum is 6, change the floor: `<6 → no trade` (handled by score gate) and shift the tiers: `score >= 7 → 1.0%`, `score === 6 → 0.5%`. The "high conviction" bonus only applies at 7 or 8 now.

Update the closing log line in `runConfluenceCheck`: `"need 4 minimum"` → `"need 6 minimum"`.

Acceptance: no entries fire below score 6 on the next paper run. Logged confluence threshold in the run banner says 6/8.

## Change 3 — Fix the trailing stop / take profit geometry

In `bot.js`, `checkExitConditions(position, usdtPrice, atr, hwm)`:

- The line `const trailingStop = hwm - atr * 2.0;` — change to `hwm - atr * 3.5;`. Looser trail lets winners breathe.
- Add a guard so the trailing stop only activates once price has moved at least `+1.0 × ATR` above entry. Before that, only the hard stop and take profit are active. Concretely: `const trailingActive = (hwm - position.entryPriceUsdt) >= atr * 1.0;` then only push the trailing-stop reason if `trailingActive` is true.
- Update the console log to print `Trailing stop:  $X.XXXX (HWM − 3.5×ATR, ${trailingActive ? "active" : "inactive — needs +1×ATR move"})`.

Leave the hard stop at 1.5×ATR. Leave the take profit at 3×ATR.

Where the HWM cold-start happens in `evaluateSymbol` — `Math.max(savedHwm || 0, usdtPrice, position.entryPriceUsdt * 1.002)` — change `* 1.002` to `* 1.0` so the trailing-active threshold isn't artificially crossed at entry.

Acceptance: in the exit-check log, trailing stop reads "inactive" on a position that's still under entry+1×ATR. Take-profit is unchanged. Hard stop is unchanged.

## Change 4 — Shorter time stop (24 bars → 8 bars on 1H)

In `bot.js`, top of the file: `const TIME_STOP_BARS = Math.ceil(24 * 60 / TF_MINUTES);` — change to `const TIME_STOP_BARS = Math.ceil(8 * 60 / TF_MINUTES);`. On 1H that becomes 8 bars / 8 hours. Median hold in our data is 3.9 h; positions that haven't moved in 8 h aren't going to.

Update the `time stop` line in `rules.json` `exit_rules.4_time_stop` from `"Close after 96 bars (24 hours on 15m)"` to `"Close after 8 bars (8 hours on 1H). Frees capital faster from dead positions."`.

Acceptance: time-stop reason text in any new exit references the 8-bar limit.

## Change 5 — Cut watchlist to 4 symbols, drop the chronic losers

Currently `SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XRPAUD,XDGAUD,LINKAUD,ADAAUD,DOTUSD,UNIUSD,ATOMUSD,SUIUSD,AVAXUSD`. The Kraken-export data shows XRP at 5.9 % WR (worst by far), DOT/UNI/ATOM never produced a profitable round trip, SUI and AVAX have wide spreads on Kraken USD pairs.

Update `.env`:
```
SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XDGAUD
```

DOGE stays because in Supabase it has the cleanest TP-hit pattern (multiple +AUD 2+ winners). Three majors + one volatile alt — covers BTC beta, ETH beta, SOL beta, and one degen sleeve.

Also update Railway env vars (`railway variables set SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XDGAUD`) so the cloud run matches local.

Acceptance: bot run banner shows `Symbols (4): XBTAUD, ETHAUD, SOLAUD, XDGAUD`.

## Change 6 — Asymmetric VWAP gate (no buying below VWAP)

In `bot.js`, `runConfluenceCheck()`, the VWAP gate currently reads:

```js
const vwapDist = vwap ? Math.abs((price - vwap) / vwap) * 100 : null;
const g2 = vwap === null ? true : vwapDist <= 1.5;
```

That's symmetric — it accepts price 1.5 % above OR below VWAP. For a long-only bot, buying below VWAP is buying into a session downtrend.

Replace with:

```js
const vwapDist = vwap ? ((price - vwap) / vwap) * 100 : null;
const g2 = vwap === null ? true : (vwapDist >= -0.5 && vwapDist <= 1.5);
```

So price must be no more than 0.5 % below VWAP and no more than 1.5 % above. The log line should print the signed distance, not the absolute value.

Acceptance: a setup where price is 0.8 % below VWAP now fails the VWAP gate (it previously passed).

## Change 7 — Internal 4H gate for entries, hourly for exits

The Railway cron stays `0 * * * *` (hourly). We don't want to fragment cron into two jobs. Instead, inside `bot.js` `evaluateSymbol`, gate entry evaluation by hour-of-day:

Near the top of `evaluateSymbol`, after the position-exit branch (~ the line `// ── ENTRY: duplicate limit order guard ──`), add:

```js
const utcHour = new Date().getUTCHours();
if (utcHour % 4 !== 0) {
  console.log(`  ⏰ Entry check skipped — only fires on 4H boundary (current UTC ${utcHour}h)`);
  return;
}
```

This makes entries only evaluate at UTC 00, 04, 08, 12, 16, 20. Exits still run every hour through the position-exit branch above this guard.

Also add a comment block above the guard explaining why: hourly entries on chop produce too many marginal trades; 4H reduces signal noise by 4× without losing real setups.

Acceptance: on UTC hours not divisible by 4, the entry section logs the skip message and no buy is placed. Exits still process normally for open positions.

## After applying all seven changes

1. Print a unified diff of every line you changed in `bot.js`, `.env`, and `rules.json`.
2. Run `node bot.js` once in paper mode (env should already have `PAPER_TRADING=true` — if not, set it temporarily and remind me to flip back when I'm ready).
3. From the run output, confirm each of these in your reply:
   - Watchlist line shows 4 symbols.
   - Confluence threshold shows 6/8.
   - Entry skip message appears if current UTC hour isn't a multiple of 4.
   - VWAP gate prints a signed distance.
   - Any new exit uses `ordertype: limit` with `oflags: post`.
   - Trailing stop shows "inactive" until +1×ATR move.
   - Time stop references 8 bars.
4. Commit on a branch called `tier1-fixes` with message `Tier 1: post-only exits, score 6/8, looser trail, 8h time stop, 4-symbol watchlist, asym VWAP, 4H entries`. Do not push.

Stop and report when done. Do not start Tier 2 work. Wait for me to verify the paper output before going live.
