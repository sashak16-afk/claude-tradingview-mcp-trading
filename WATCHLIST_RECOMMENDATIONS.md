# Watchlist — what to drop, what to add

## What you have now (12 symbols)

```
XBTAUD, ETHAUD, SOLAUD, XRPAUD, XDGAUD, LINKAUD, ADAAUD,
DOTUSD, UNIUSD, ATOMUSD, SUIUSD, AVAXUSD
```

## What your data says about each one

Based on FIFO-matched round trips from the Kraken export (Apr 13 → May 11) and the Supabase `bot_trades` table.

| Symbol | Round trips | WR | Total P&L | Verdict |
|---|---|---|---|---|
| **XBTAUD** | 21 | 9.5 % | −AUD 18.19 | Keep — needs the geometry fix to express |
| **ETHAUD** | 6 | 16.7 % | −AUD 5.27 | Keep — clean trends, ATR-friendly |
| **SOLAUD** | 10 | 20.0 % | −AUD 6.25 | Keep — highest WR of any pair, real momentum |
| **XDGAUD** | 16 | 12.5 % | −AUD 10.34 | Keep — multiple TP hits in Supabase, your only memecoin sleeve |
| **XRPAUD** | 17 | 5.9 % | −AUD 16.13 | **Drop** — your worst pair, chops on news flow |
| **LINKAUD** | 6 | 16.7 % | −AUD 6.86 | Optional — mid-tier; cut for Tier 1, revisit Tier 2 |
| **ADAAUD** | 0 round trips | — | — | **Drop** — no setups firing, illiquid Kraken AUD |
| **DOTUSD** | 0 round trips | — | — | **Drop** — no momentum in 2026, narrative-dead |
| **UNIUSD** | 0 round trips | — | — | **Drop** — same |
| **ATOMUSD** | 0 round trips | — | — | **Drop** — same |
| **SUIUSD** | 0 round trips | — | — | **Drop** for now — wide Kraken spread, revisit when liquid |
| **AVAXUSD** | 0 round trips | — | — | **Drop** — story has faded in 2026 |

## Tier 1 watchlist — what to set today

```
SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XDGAUD
```

Four symbols. One BTC-beta major, one ETH-beta major, one SOL-beta momentum coin, one memecoin volatility sleeve. Together this covers ~95 % of crypto-correlated risk in 2026 with deeper Kraken AUD liquidity. Your bucket caps (`MAX_PER_BUCKET = 2`) still work cleanly with this list.

## Symbols to consider adding once Tier 1 is paying

These are the 2026 narrative leaders the data, sentiment trackers, and influencer flow keep pointing at. All are tradable on Kraken (USD pair denoting the Kraken symbol).

| Symbol | Kraken pair | Why it deserves a slot | Risk |
|---|---|---|---|
| **HYPE** | `HYPEUSD` | Hyperliquid native token. Most-discussed perp-DEX of 2025-26, parabolic flow into 2026. Clean trend structure on 1H–4H. | High vol; can pump 20 % in a day |
| **TAO** | `TAOUSD` | Bittensor. AI thematic leader, strong holder base. Trends cleanly, ATR-friendly. | Lower liquidity than majors; wider spread |
| **TON** | `TONUSD` | Toncoin. Telegram association + retail flow. Catalyst-driven. | News-sensitive; gaps |
| **AAVE** | `AAVEAUD` | DeFi blue chip. More measured momentum than memes. AUD-denominated → no FX leg. | Slower; needs patience |
| **JUP** | `JUPUSD` | Jupiter (Solana DEX aggregator). High-beta SOL exposure with its own narrative. | Volatile; thinner book |
| **WIF** | `WIFUSD` | dogwifhat. Top memecoin in 2025-26 by volume. Mirrors XDG behaviour but more violent. | Extreme vol; do not overweight |

Add at most one or two of these per fortnight, not all at once. Watch their behaviour against your fixed bot for two full weeks (8 entries minimum) before declaring them a keep.

## Suggested phased rollout

**Tier 1 (today):** 4 symbols above. Run for 2 weeks paper, flip to live, observe for another 2 weeks.

**Phase 2 (week 3-4 if Tier 1 is producing positive PF):**
```
SYMBOLS=XBTAUD,ETHAUD,SOLAUD,XDGAUD,HYPEUSD,TAOUSD
```

**Phase 3 (month 2 if Phase 2 sustains):** Optionally add `AAVEAUD` and `WIFUSD`. Lift `MAX_PER_BUCKET` from 2 to 3, add a new "NARRATIVE" bucket for HYPE/TAO/TON so they don't cannibalise BTC-beta allocation.

## One more thing — Kraken minimum order sizes for the new symbols

You'll need to extend `KRAKEN_MIN_ORDER` in `bot.js` when you add them. Best values as of May 2026 (verify against Kraken's AssetPairs endpoint when you wire each one in):

```js
HYPEUSD: 1,
TAOUSD:  0.05,
TONUSD:  2,
AAVEAUD: 0.05,
JUPUSD:  10,
WIFUSD:  10,
```

Also add Binance symbol maps for each so the bot can pull candles:

```js
HYPEUSD: "HYPEUSDT",
TAOUSD:  "TAOUSDT",
TONUSD:  "TONUSDT",
AAVEAUD: "AAVEUSDT",
JUPUSD:  "JUPUSDT",
WIFUSD:  "WIFUSDT",
```

Drop these into `BINANCE_SYMBOL_MAP`, `KRAKEN_BASE`, `KRAKEN_PAIR_PATTERN`, and `QUOTE_CURRENCY` when you add the symbol. Then create a bucket entry — I'd suggest a new `BUCKETS.NARRATIVE = ["HYPEUSD","TAOUSD","TONUSD"]` and `BUCKETS.MEMES = ["XDGAUD","WIFUSD"]` to keep correlation buckets clean.
