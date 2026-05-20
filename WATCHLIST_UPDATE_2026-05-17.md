# Watchlist re-evaluation — 2026-05-17

## What's changed in the last 6 days

| Signal | Value | Read |
|---|---|---|
| BTC dominance | ~58–60 % | Still Bitcoin Season |
| CMC Altseason Index | 39 / 100 | Bitcoin Season (need >75 for altseason) |
| Alts < 50d MA | 89 % | Brutal alt tape |
| BTC spot-ETF cumulative inflows | $87 B+ | Money flowing into BTC, not alts |
| Predicted altseason window | May–July 2026 | Not yet triggered |

Conclusion: a long-only momentum bot on alts is structurally fighting the tape right now. The right move is *more* concentration, not less. Last week's "Phase 2 — add HYPE, TAO, AAVE" needs revising because two of those three have rolled over in the last 7 days.

## What's actually moving in mid-May 2026

| Symbol | Status | Verdict |
|---|---|---|
| **SOL** | +180 % YTD, strongest blue-chip | **Keep — core** |
| **HYPE** (Hyperliquid) | +68–76 % YTD, *outperformed in risk-off* — institutional conviction | **Add** |
| **TRX** (Tron) | +7 % in May, 8-month high, stablecoin settlement demand, low-vol uptrend | **Add** |
| **DOGE** | +4.75 % recent, leads memes | Keep |
| **ETH** | +3.90 % recent, range-bound | Keep |
| **TAO** (Bittensor) | −12.43 % in last 7 days — rolled over | **Wait** (was on add list, now off) |
| **SUI** | −10 % on May 15, 5-day downtrend | **Wait** |
| **TON** | Rallied but technical downtrend unbroken | **Wait** |
| **AAVE / SEI / ARB / OP / NEAR** | Bullish divergence forming, not confirmed | **Wait** — bottom-fishing, not trend-following |
| **WIF / JUP / BONK** | Speculative memes underperforming in BTC season | **Skip** until altseason index > 60 |

## Updated watchlist plan

### Tier 1 (now — unchanged from last file)

```
SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XDGAUD
```

Still the right call. In a Bitcoin-Season tape with 89 % of alts under their 50d MA, four symbols is the correct concentration. DOGE stays because it's still one of the alts that *is* working.

### Phase 2 (revised — replace TAO with TRX, drop TON for now)

Once Tier 1 has been running for 2 weeks with a positive profit factor:

```
SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XDGAUD,HYPEUSD,TRXUSD
```

**Why HYPE:** outperforming the market in a risk-off month is institutional conviction, not retail froth. Kraken margin support confirmed. Volatility is high but trend structure is clean on 1H–4H.

**Why TRX (replaces TAO):** TRX is at an 8-month high on real underlying demand (stablecoin settlement volume on Tron is at record highs). Low-vol uptrend is exactly the shape your confluence strategy was built for. TAO got dropped because it's −12 % over the last 7 days — wait for a higher low to form before reconsidering.

### Phase 3 (month 2+, only if altseason index breaks above 60)

Watch list, not active. Promote one at a time when the index turns:

```
TAOUSD, TONUSD, AAVEAUD, ARBUSD, SEIUSD
```

These are the early-bottom-formation candidates. None of them have *confirmed* a trend reversal yet, so they're conditional adds, not committed adds. Wait for: weekly RSI > 50, price > 50d MA, and the alt-season index > 60. Then promote one at a time.

### Permanent drops (delete these from any future iteration)

`XRPAUD, ADAAUD, DOTUSD, UNIUSD, ATOMUSD, SUIUSD, AVAXUSD` — your Kraken data shows zero or losing round trips, and current narratives confirm the read.

## The one thing that overrides all of this

**Your BTC regime gate is the most important filter you have right now.** With BTC dominance at 60 %, the gate is doing real work. Do not loosen it. If anything, tighten: add a second BTC condition — `BTC.D < 60 OR BTC trend up` for alt entries. When BTC.D rises, alts bleed. That's the May 2026 regime in one rule.

---

## Terminal prompt — paste this whole block into Claude Code

Open Claude Code in `claude-tradingview-mcp-trading/` and paste everything below the line. It applies the watchlist update plus the BTC-dominance overlay. Run after the Tier 1 prompt — they compose cleanly.

---

You are working in this repo. Apply two changes only. Do not refactor anything else. Print a diff for each change.

### Change A — Update the watchlist to Tier 1 / Phase 2 ready state

Update `.env` line:
```
SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XDGAUD
```

Also run `railway variables set SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XDGAUD` so the cloud run matches local. If `railway` CLI is not installed or I'm not logged in, just print the command for me to run and continue.

In `bot.js`, the existing `KRAKEN_MIN_ORDER`, `BINANCE_SYMBOL_MAP`, `KRAKEN_BASE`, `KRAKEN_PAIR_PATTERN`, and `QUOTE_CURRENCY` already include entries for `XBTAUD`, `ETHAUD`, `SOLAUD`, `XDGAUD` — leave them alone.

Add (but do not activate yet) Phase 2 entries to those maps so the Phase 2 flip later is one env-var change:

```js
// BINANCE_SYMBOL_MAP additions
HYPEUSD: "HYPEUSDT",
TRXUSD:  "TRXUSDT",

// KRAKEN_BASE additions
HYPEUSD: "HYPE",
TRXUSD:  "TRX",

// KRAKEN_PAIR_PATTERN additions
HYPEUSD: "HYPE",
TRXUSD:  "TRX",

// QUOTE_CURRENCY additions
HYPEUSD: "USD",
TRXUSD:  "USD",

// KRAKEN_MIN_ORDER additions (Kraken AssetPairs values, verify on first live use)
HYPEUSD: 0.2,
TRXUSD:  20,
```

In `BUCKETS`, add a new bucket and reorganise so memes are isolated and the new narrative names have a home. Replace the existing `BUCKETS` block with:

```js
const BUCKETS = {
  BTC_BETA:  ["XBTAUD", "ETHAUD", "SOLAUD", "ADAAUD"],
  ALT_BETA:  ["XRPAUD", "LINKAUD", "ATOMUSD", "DOTUSD"],
  MEMES:     ["XDGAUD", "WIFUSD"],
  NARRATIVE: ["HYPEUSD", "TRXUSD", "TAOUSD", "TONUSD"],
  USD_PAIRS: ["UNIUSD", "SUIUSD", "AVAXUSD"],
};
```

Keep `MAX_PER_BUCKET = 2` for now. The new bucket structure means Phase 2 can add HYPE+TRX without competing with BTC-beta slots.

### Change B — Tighten the BTC macro gate (Bitcoin Season 2026 overlay)

In `bot.js`, `checkBtcRegime()` currently only checks BTC price vs its 1H EMA(200). In a Bitcoin-Season tape where BTC dominance is rising, alts bleed even when BTC itself looks neutral. Add a BTC-dominance read to the same function.

Modify `checkBtcRegime()` so it returns an object:
```
{ bullish: <existing bool>, btcDOver60: <bool>, blockAltLongs: <bool> }
```

The new fields:
- `btcDOver60`: fetch BTC dominance — simplest free source is to derive it: pull `https://api.coingecko.com/api/v3/global` once, read `data.market_cap_percentage.btc`, and set `btcDOver60 = value > 60`. If the fetch fails, default `btcDOver60 = false` (fail-open).
- `blockAltLongs`: `!bullish || btcDOver60`. If BTC is in bear regime OR BTC dominance is above 60, block long entries on all non-BTC symbols.

In `run()`, where you currently check `if (!btc.bullish)`, replace with two checks:
- If the current symbol is `XBTAUD` AND `!btc.bullish` → skip entry, still check exits (existing behaviour).
- If the current symbol is NOT `XBTAUD` AND `btc.blockAltLongs` → skip entry, still check exits. Log the reason: `BTC.D > 60 — alt longs blocked` or `BTC bear regime — alt longs blocked`.

This is the single highest-leverage market-regime rule for May 2026 conditions. It costs you one CoinGecko request per cron run (well under their free-tier limit) and prevents bleed-on-bleed alt entries in Bitcoin Season.

Print before/after diffs. Run `node bot.js` once in paper mode. Confirm in your reply:
- Run banner lists 4 symbols.
- BTC regime check log now shows `BTC.D = X.XX %` and `Alt longs: ALLOWED | BLOCKED`.
- At least one alt symbol logs the new "BTC.D > 60 — alt longs blocked" message if dominance is above 60.

Stop and report when done. Do not touch confluence score, exit logic, or any of the Tier 1 work — that's a separate prompt.

---

## Sources used

- [Altcoin Season 2026 — Spoted Crypto](https://www.spotedcrypto.com/altcoin-season-2026-btc-dominance-sector-breakout/)
- [Bitcoin Dominance May 2026 — TradingView Hub](https://www.tv-hub.org/guide/bitcoin-dominance)
- [Bitcoin Dominance at 60.3 % — capital rotation analysis](https://www.ainvest.com/news/bitcoin-dominance-60-3-flow-analysis-capital-rotation-altcoins-2605/)
- [3 Altcoins Defying Bitcoin's Gravity in 2026 — Crypto Economy](https://crypto-economy.com/3-altcoins-defying-bitcoins-gravity-in-the-2026-crypto-market/)
- [Top 5 Altcoins to Watch in May 2026 — Spoted Crypto](https://www.spotedcrypto.com/top-5-altcoins-may-2026/)
- [Hyperliquid (HYPE) Price Prediction 2026 — Coinpedia](https://coinpedia.org/price-prediction/hyperliquid-hype-price-prediction/)
- [Bittensor TAO Price Prediction — Changelly](https://changelly.com/blog/bittensor-tao-price-prediction/)
- [SUI Crypto Price Prediction May 16 2026 — CoinCodex](https://coincodex.com/article/84839/sui-prediction-may-16-2026/)
- [Altcoins to Watch — SEI, ARB, AAVE, INJ, FIL — MEXC](https://www.mexc.com/news/977683)
- [3 Altcoins That Can Hit Record High Prices in May 2026 — BeInCrypto](https://beincrypto.com/altcoins-all-time-high-potential-may-2026/)
- [Kraken margin pairs — BONK, TAO, STX, JUP](https://blog.kraken.com/product/asset-listings/expanded-margin-pairs-available-for-bonk-tao-stx-and-jup)
- [Kraken EUR margin pairs — HYPE, JUP, others](https://blog.kraken.com/product/margin/eur-pairs-bnb-w-hype-hbar-jup)
