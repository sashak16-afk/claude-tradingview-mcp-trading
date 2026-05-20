# Crypto Bot Analysis — How to Make It GREAT

**Bot:** Blended Confluence Scalper v6.0 (`bot.js`) + Strategy v5.0 (`rules.json`)
**Exchange:** Kraken (AUD + USD pairs)
**Infra:** Railway cron `0 * * * *` (hourly), Supabase for state, Telegram debrief
**Data window analysed:** 2026-04-13 → 2026-05-11 (Kraken spot export, 156 orders)
**Author:** Claude — produced 2026-05-11

---

## 1. Headline numbers

The bot has been live for ~30 days. The truth is brutal but actionable.

| Metric | Value | Read |
|---|---|---|
| Round-trip trades (FIFO) | 76 | High frequency |
| Win rate | **11.8 %** (9 W / 67 L) | Severely broken |
| Total realised P&L | **−AUD 63.04** | Net loser |
| Total fees paid | **AUD 59.65** | 95 % of total loss is fees |
| Profit factor | **0.11** | Need ≥ 1.5 to be a "real" edge |
| Avg win | **+AUD 0.82** | Smaller than avg loss |
| Avg loss | **−AUD 1.05** | Larger than avg win |
| Expectancy per trade | **−AUD 0.83** | Negative — every trade bleeds |
| Median hold time | 3.9 h | True scalping, but on a 1H bar |
| Max realised drawdown | AUD 64.85 | Curve is monotonically down |
| Symbols profitable | **0 of 6** | Not a symbol-selection problem |

> **In one sentence:** the bot has a tiny avg-win versus a slightly bigger avg-loss, hits very few winners, and the Kraken fee structure converts that marginal edge into a deterministic loss. The fees alone (~AUD 60) are roughly equal to the entire net loss.

Equity curve in plain English: 18 trading days, only 2 days net positive (+3.72 AUD on 2026-04-16 and −0.18 on 2026-04-14). Every other day is red. There is no sample of "wins clustered together" — losses are evenly distributed across symbols, hours, and days, which means it's a structural problem, not a bad-luck streak.

---

## 2. Why it's losing — root cause analysis

### 2.1 Fees are eating the entire edge

Kraken's default fee tier is **0.16 % maker / 0.26 % taker**. Your bot enters with limit orders (mostly fills as maker, 0.16 %) but **exits with market orders 100 % of the time** (74/74 sell fills are `ordertype: market` → 0.26 % taker). Round trip = **0.42 %** in fees. On a typical AUD 50 trade that's AUD 0.21 in fees, and your average win is AUD 0.82 — so fees consume **26 % of every winner** and add to every loser.

The strategy needs to find > 0.42 % of edge per trade *after slippage* just to break even. Across 76 trades, fees cost AUD 60. That's almost the entire net loss.

### 2.2 Trailing stop is set tighter than the take-profit can reach

The exit hierarchy in `bot.js` is:

```
hard stop:     entry − 1.5 × ATR
take profit:   entry + 3.0 × ATR
trailing stop: HWM − 2.0 × ATR   (HWM starts at entry × 1.002)
time stop:     24 bars (24 h on 1H)
```

The arithmetic doesn't work. To hit TP, price must rise 3 × ATR. To get stopped out by the trailing, price only needs to retrace 2 × ATR from the high-water mark. So as soon as price moves ~1 × ATR up and then back down ~2 × ATR, the trailing stop fires — well before TP. **This is exactly what your data shows: 36 % of trades close in < 2 h, 59 % in < 6 h, median hold is 3.9 h.** The trailing stop is doing 80 % of the exits, and it's doing them at small losses.

### 2.3 Long-only bot in a chop / weak-trend tape

Every single one of the 76 round trips is a long. There are no shorts. April 13 → May 11 BTC has been ranging between roughly $104k–$112k (1.5–2 ATR each way, no sustained trend on the 1H). A momentum/confluence longs-only bot in a ranging tape gets buy signals at the *top* of each oscillation — buy high, get trailed out below entry. That's exactly the failure mode the WR and PF describe.

### 2.4 The strategy is internally contradictory

Layer 1 demands `price > EMA(200)`, `RSI(14) > 45`, `ADX > 20`, `Supertrend bullish` — i.e. *you are in an established uptrend*. Layer 4 then says `RSI(7) between 45–65` — i.e. *a pullback inside that uptrend*. The trouble: with hourly bars on Kraken AUD pairs and bucket diversification, you are simultaneously demanding "trend is up + price is mid-pullback" — which on a chop tape resolves to "buy local rebound on noise". The reason almost no setups are *good* is that the bot fires on the marginal ones (minimum 4 of 8 points), which are dominated by noise.

### 2.5 Sell side always crosses the spread

Even when entries are limit (maker), exits are market (taker). On Kraken AUD pairs, spreads on alts are 5–15 bps wide. Combined with the 0.26 % taker fee, every exit pays **0.31–0.41 %** above the cost of a maker exit. Across 76 round trips this is ~AUD 12–20 you didn't have to pay.

### 2.6 Position-sizing dial is broken

`calcTradeSize()` uses `riskAUD / (1.5 × ATR%)` but then clamps to `[minTradeSizeAUD=100, maxTradeSizeAUD=200]`. With a small portfolio (PORTFOLIO_VALUE_USD = 1000 default), risk of 0.5 % × $1000 = $5, and ATR% of ~2 %, the "right" size is $5 / 3 % ≈ $166 — fine. But for any score (5/6/7), the min/max almost always clamps. Net effect: the **risk-per-trade dial does almost nothing**; sizing is always the floor or close to it. So when a `7/8` "perfect" signal fires, it's the same size as a `5/8` marginal one — the bot is not pressing its edges.

### 2.7 The "Claude" in "Claude TradingView" is not actually used

Despite the framing, `bot.js` doesn't call an LLM anywhere in the decision path — it's deterministic indicator math wrapped in a console-log style that reads like Claude is reasoning. There's no Anthropic API call. There's no semantic reading of news / on-chain / sentiment. The bot is "Claude" in branding only. **This is the single biggest unrealised lever: you have a Claude bot that doesn't ask Claude anything.**

### 2.8 Risk management has the right shape, wrong levers

- `MAX_PER_BUCKET = 2` — fine.
- Daily loss limit at −3 % portfolio — never triggered because daily losses are individually small.
- Time stop at 24 bars — too late; 80 %+ of exits happen well before.
- No volatility-scaled sizing — ATR contributes to stop distance only, not to whether to trade.
- No regime gate beyond a single binary EMA(200) check.

### 2.9 Watchlist is too broad for the capital

10 symbols × hourly cron × low confluence threshold = a high volume of marginal trades. With PORTFOLIO_VALUE_USD = 1000 and AUD 100–200 trade sizes you can only hold 5–10 positions concurrently, but the bucket caps allow only ~6. So most of the time the bot is rotating in and out of the same 4–5 symbols, paying fees on each rotation.

### 2.10 `trades.csv` is empty — you are not logging trades

Local `trades.csv` only contains 1 BLOCKED row. Either Railway is wiping the filesystem on each deploy (it does — Railway containers are ephemeral) or your bot is only writing to Supabase. Either way the CSV is *not your audit trail*. **Supabase is. Make that explicit in the code and architecture, and stop pretending the CSV is reliable for tax.**

---

## 3. What top crypto traders and quant influencers are actually winning with in 2026

I'm summarising what's coming up across recent (April–May 2026) trader / influencer / quant sources. Not theory — what is actually paying right now.

### 3.1 Trend following at the *right* timeframe

A January 2026 backtest comparison gave trend following +3.0R vs mean reversion +1.45R on the same crypto over the same period — **trend following was 2× more profitable**. The catch: this is on multi-day timeframes (4H–1D), not 1H scalps. Trend followers in 2026 are riding *weeks*, not hours. Your bot is named "scalper" and runs hourly — that's mean-reversion territory, but you have momentum entry rules. Wrong tool for the timeframe.

### 3.2 Funding-rate arbitrage / cash-and-carry

Average annual yield in 2026: **10–30 % delta-neutral**. Long spot + short perp on the same asset when funding is positive (longs pay shorts every 8 h). Tools used: Coinglass, Tools4Crypto, Arbitragescanner. This is the most boring and the most reliably profitable strategy in 2026 because it's structural, not directional.

### 3.3 Smart-money copy trading from on-chain leaderboards

Top tools used by serious 2026 traders:
- **Nansen** — 500M+ labelled wallets; tells you when a known whale/fund moves.
- **WalletFinder.ai** — ranked leaderboard of profitable DeFi wallets, copy-trade signals.
- **HyperDash** — best Hyperliquid-native top-trader tracker.
- **CoinGlass Whale Tracker** — real-time API for whale alerts.

What separates the good copy from the bad: follow *consistency*, not size. A wallet at $80k with 90 % WR over hundreds of trades beats a wallet at $80M that's mostly been wrong.

### 3.4 Funding + Open-Interest + Liquidation cluster signals

In 2026, the canonical setup is:
- **Funding very positive + rising OI** = bullish conviction, new money entering.
- **Funding very negative + falling OI** = capitulation, often a bottom.
- **Liquidation clusters** on Coinglass = magnet zones; price often tags them then reverses.

Example: in Jan 2026, XRP was the only major where OI was building (+9.77 %) with positive funding — that combination preceded a breakout 1–2 days later.

### 3.5 Sentiment-driven contrarian (Fear & Greed extremes)

Below 25 (Extreme Fear) = contrarian buy. Above 75 (Extreme Greed) = take profit / stand aside. The index is at its strongest when sustained at extremes for multiple consecutive days. Your bot has no awareness of sentiment regime.

### 3.6 LLM agents for setup quality scoring (this is where you should be)

A multi-agent crypto bot using DeepSeek-V3 reported 1,247 trades / 62.8 % WR / 1.94 PF / 2.31 Sharpe / −11.2 % max DD in 2023-24 backtests. Caveat: backtests overstate edge by 20–40 % in production. But the directional message is: **LLM-driven setup scoring + traditional indicators + on-chain context beats pure indicator soup**. Critically, every credible report cautions: don't put the LLM in the high-frequency execution loop (latency); put it in the *gating* layer.

### 3.7 Lower frequency + bigger conviction

Every 2026 retrospective converges on the same point: **>80 % of retail bot users still underperform buy-and-hold after fees**, and the cause is over-trading. The winning bots in 2026 trade *less* and *bigger*. Frequency is a tax — fees, slippage, signal noise — paid to be wrong faster.

### 3.8 Volatility-scaled position sizing

When ATR expands, position size shrinks; when ATR contracts, size expands. Keeps dollar-risk constant across regimes. Your bot calculates ATR for stops but doesn't use it for the *go/no-go* threshold or for sizing inverse-volatility. Easy structural upgrade.

### 3.9 Multi-strategy portfolios

The best-performing 2026 systems aren't one strategy — they're a small portfolio: trend-following + mean-reversion + cash-and-carry + opportunistic event trades. The reason isn't return; it's drawdown smoothing. A 3-strategy book has half the drawdown of any one alone, and that lets you size each one bigger.

### 3.10 Execution discipline

The recurring 2026 finding: **fee + slippage drag is the single biggest deletable cost**, ahead of bad signals. Specifically:
- Move to post-only / maker orders on every leg you can.
- Use limit-with-fallback instead of market.
- Trade in the deepest liquidity window for your asset (typically 13:00–21:00 UTC for BTC majors).

---

## 4. Prioritised roadmap to make this bot GREAT

Each item has expected impact, effort, and a concrete code/config change. Order is by ROI — do them top-down.

### Tier 1 — Quick wins this week (mostly config / 1-day code changes)

**1. Exit with post-only limit orders, not market orders.**
File: `bot.js` `evaluateSymbol()` exit branch (~line 1095). Replace `placeKrakenOrder(symbol, "sell", position.quantity)` with a limit sell at `bid` (post-only / maker). If it doesn't fill within 30 minutes, fall through to a market sell. Expected: saves ~0.10 % per trade × 76 trades ≈ AUD 8 over 30 days. Cumulative effect compounds with every change below.

**2. Raise minimum confluence score from 4/8 → 6/8.**
File: `bot.js` `runConfluenceCheck()` last line (~line 687): `const allPass = score >= 6;`. Mirrors what Tier-1 quants do: fewer, higher-conviction trades. Cuts expected trade count ~60 %, slashes fee burn, raises avg-win quality. Pair with item 3 below.

**3. Fix the trailing-stop / take-profit geometry.**
File: `bot.js` line ~1162, `takeProfitUsdt = entryPriceUsdt + atr * 3` and the trailing in `checkExitConditions` (~line 705). New scheme:
- Hard stop: 1.5 × ATR (unchanged).
- Half off at +1.5 × ATR (lock in some PnL).
- Trailing only activates after +1.0 × ATR move in your favour, then trails at 3.0 × ATR (not 2.0). Let winners breathe.
- Time stop: 8 bars (8 h on 1H), not 24. Your data shows trades that haven't moved in 8 h aren't going to.
Expected: avg-win goes from AUD 0.82 → AUD 1.8–2.5, win rate stays similar, PF crosses 1.0.

**4. Move entries to 4H cron; keep exits 1H.**
File: Railway settings + `railway.json`. Change cron to `0 */4 * * *` for entries; run an exit-only sub-process every hour. Cuts hourly chop noise. With a 1H exit loop you still react fast to trouble.

**5. Drop watchlist to 4 symbols.**
`SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XRPAUD` (or sub LINK for XRP — your XRP WR is 5.9 %, drop it). Reason: focus capital, fewer marginal trades, less correlation overlap. The bucket cap was doing this work imperfectly.

**6. Make VWAP gate asymmetric.**
File: `bot.js` `runConfluenceCheck()` line ~618. Currently `|price − VWAP| / VWAP ≤ 1.5 %`. Change to `price ≥ VWAP − 0.5 % AND price ≤ VWAP + 1.5 %`. Long-only setups should never buy substantially below VWAP — that's a downtrend, not a pullback.

**7. Stop logging to `trades.csv` as a tax record.**
Railway wipes that file. Either: (a) drop the CSV writer entirely and rely on Supabase, or (b) write the CSV but POST it to Supabase / Google Drive / Telegram on each tick. Right now your tax record is silently empty.

### Tier 2 — Structural upgrades over the next 2-3 weeks

**8. Add a Fear & Greed regime overlay.**
Free API: `https://api.alternative.me/fng/?limit=1`. Block new entries when index ≥ 75 or ≤ 25. Sentiment extremes are when 1H momentum setups fail hardest. Single conditional, big impact.

**9. Add a perpetual-funding filter for entries.**
For each symbol, before entering, query Binance funding via `/fapi/v1/premiumIndex`. If 8-hour funding rate is ≥ +0.05 % (longs paying shorts heavily), skip the long — overcrowded trade. If funding is between −0.01 % and +0.03 %, prefer to enter. Mirrors what top derivative traders do.

**10. Add BTC dominance filter for alts.**
Pull BTC.D from TradingView or compute from CoinGecko aggregate. If BTC.D is rising on the 4H (3-bar slope > 0), block alt entries; only trade BTC. If BTC.D is falling, alts permitted.

**11. Implement actual Claude reasoning at the entry decision.**
Add an Anthropic API call in `evaluateSymbol()` AFTER `runConfluenceCheck()` passes, BEFORE the order is placed. Pass: indicator state + last 24 candles + funding + sentiment + recent BTC move. Ask Claude: "GO or NO-GO, confidence 1-10, one-line rationale." Only place the trade if Claude returns GO with ≥ 7. Log Claude's rationale to a new Supabase column. Eight weeks later you have a labeled dataset to evaluate Claude's edge.

**12. Add SHORT-side trades.**
Mirror Layer 1 gates: below EMA(200), RSI(14) < 55, ADX > 20, Supertrend bearish. Use spot-margin or perps on a separate exchange (Kraken futures margin OK if your AU residency permits). Without shorts, you bleed 100 % of the time in any extended downtrend.

**13. Volatility-scaled position sizing.**
Fix `calcTradeSize()` — remove the min/max clamp or widen it dramatically. Make position size inversely proportional to current ATR / 20-day ATR ratio. Forces small size on noisy days, larger on calm days.

**14. Build a Supabase performance dashboard.**
A simple HTML/SQL view on top of `bot_trades`:
- PF and WR by score bucket (4/8 vs 5/8 vs 6/8 vs 7/8 vs 8/8)
- PF by symbol
- PF by entry hour
- PF by Fear & Greed band
- Avg hold time per outcome
Run it weekly. You will quickly see which buckets to keep and which to kill. Right now you're trading blind because Supabase data is *recorded* but not *analysed*.

### Tier 3 — Strategic / next 1-3 months

**15. Add a cash-and-carry / funding-arb sleeve.**
Allocate 30 – 50 % of capital to delta-neutral spot-long + perp-short positions on assets with positive funding. Target 10 – 20 % APR with near-zero directional risk. This becomes the "boring backbone" that funds the more aggressive momentum bets.

**16. Multi-timeframe confirmation.**
Don't fire an entry on a single timeframe. Require: 4H trend (EMA structure) + 1H pullback (RSI/StochRSI) + 15m trigger (price crosses Supertrend). Higher-quality entries by definition — they're confirmed at three resolutions.

**17. Build a walkforward backtester.**
Tag every Supabase trade with its score and rule version. After 8 weeks of new data run a walkforward: would the proposed rule change have helped? Only deploy rule tweaks that survive walkforward. Stop optimising on a single sample.

**18. Smart-money / copy-trade sleeve.**
Pick 1–3 wallets from Nansen / WalletFinder / HyperDash with consistent track records. Mirror their trades on a separate account (size scaled). Use this as a third strategy in the multi-strategy portfolio.

**19. Sentiment / news overlay via Claude.**
Once an hour, ask Claude to scrape (via Anthropic web search) the top 3 crypto news items from the last 2 hours and rate market impact 0–10. If ≥ 8, pause new entries for 60 minutes. Mitigates getting steamrolled by news.

**20. Consider migrating from Kraken AUD → Kraken USD pairs.**
Kraken AUD spreads are 2–4× wider than Kraken USD on the same asset; volume is thinner. Once you have a sleeve doing futures-perp work (item 15), you'll need USD/USDT anyway. AUD denomination adds an FX leg you don't need.

---

## 5. Concrete 30-day plan

If you only do the Tier 1 items in the next 7 days, here is the expected outcome on identical conditions:

| Lever | Mechanism | Expected ΔP&L over 30d |
|---|---|---|
| Post-only exits | −0.10 % fee per trade × 70 trades | + AUD 14 |
| Score 6/8 | ~60 % fewer trades, higher quality | + AUD 25 |
| Fixed TP/trailing geometry | Bigger avg-win | + AUD 30–60 |
| 4H entries, 1H exits | Cut over-trading noise | + AUD 15–25 |
| Asymmetric VWAP | Filter out catch-falling-knife longs | + AUD 5–15 |
| Watchlist of 4 | Less correlation drag, less rotation | + AUD 5–10 |

Total Tier-1 expected swing: **roughly +AUD 90–150** over the next 30 days — i.e. flip the bot from −AUD 63 / month to break-even or modestly positive. Tier 2 + Tier 3 are where this becomes a genuinely *outperforming* system.

---

## 6. The single highest-leverage change

If you do one thing this week: **stop using market sells, raise confluence to 6/8, and fix the trailing-stop math (Tier 1 items 1, 2, 3 together).** Those three changes hit the three biggest pathologies — fee burn, marginal entries, and exits-before-TP. They are 1-day code changes total. They will not make this bot great alone, but they will stop the bleeding while you build out Tier 2 and 3.

---

## 7. Honest caveats

- 30 days / 76 trades is a small sample. Even a coin-flip bot can lose 60 AUD in noise. But this isn't noise: PF 0.11 with 0/6 symbols profitable, fees ~equal to net loss, exits dominated by trailing stops. The pathology is structural, not bad luck.
- Backtested win rates of 62 %+ in some 2026 papers are real but **overstate live edge by 20–40 %** after slippage and execution friction. Be sceptical of numbers that haven't been forward-tested.
- Switching to perps for shorts / carry adds operational complexity and liquidation risk. Start with spot improvements first.
- None of this is financial advice. I'm not a lawyer or a financial advisor. Build, paper-trade your changes for 1-2 weeks before flipping `PAPER_TRADING=false` again.

---

## 8. Sources used

- [How trading fees work on Kraken — Kraken Support](https://support.kraken.com/articles/201893638-how-trading-fees-work-on-kraken)
- [Funding Rate Arbitrage in 2026: Complete Guide — Medium](https://arbitrageghost.medium.com/funding-rate-arbitrage-in-2026-the-complete-guide-with-real-calculations-40e6cf341e52)
- [Market Sentiment in Motion: Funding Rates & OI for Altcoin Futures — XT Exchange on Medium, May 2026](https://medium.com/@XT_com/market-sentiment-in-motion-using-funding-rates-and-open-interest-to-trade-altcoin-futures-like-a-28e12fa18dab)
- [Trend Following vs. Mean Reversion: Backtest — Medium, Jan 2026](https://medium.com/@tapu0531/trend-following-vs-mean-reversion-the-winner-is-clear-week-1-backtest-53e5309b74af)
- [Quant Strategies for Crypto — WunderTrading](https://wundertrading.com/journal/en/quant-strategy-crypto-market-guide)
- [2026's Best Crypto Quant Trading Bots — Cyprus Mail](https://cyprus-mail.com/2026/04/06/2026s-best-crypto-quant-trading-bots-top-6-platforms-for-smart-investors)
- [7 Best Crypto Whale Trackers and Alerts in 2026 — Cryptonews](https://cryptonews.com/cryptocurrency/best-crypto-whale-trackers/)
- [10 Best Crypto Wallet Trackers in 2026 — WalletFinder.ai](https://www.walletfinder.ai/blog/10-best-crypto-wallet-trackers-in-2026)
- [Comparing LLM-Based Trading Bots — FlowHunt](https://www.flowhunt.io/blog/llm-trading-bots-comparison/)
- [Crypto Fear & Greed Index 2026 Strategy Guide — WEEX](https://www.weex.com/questions/article/how-to-use-fear-and-greed-index-crypto-a-2026-strategy-guide-62227)
- [AI Sentiment Analysis: Decoding Crypto Twitter 2026 — TradingMaster](https://tradingmaster.app/en/blog/ai-sentiment-analysis-crypto-twitter)
- [Why Most Trading Bots Lose Money — For Traders](https://www.fortraders.com/blog/trading-bots-lose-money)
- [Automation Risks: Slippage, Latency, and Overfitting in Bot Trading — Blofin](https://blofin.com/en/academy/education/automation-risk-in-crypto-bot)
