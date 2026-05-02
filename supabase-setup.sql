-- Trading Bot v5.0 — Supabase Schema
-- Run this entire file in your Supabase project SQL editor before going live.
-- Dashboard → SQL Editor → New query → paste → Run

-- ── bot_state ─────────────────────────────────────────────────────────────────
-- Key/value store. Used for: high-water marks (hwm_SYMBOL → USDT price string)
CREATE TABLE IF NOT EXISTS bot_state (
  key        text PRIMARY KEY,
  value      text,
  updated_at timestamptz DEFAULT now()
);

-- ── bot_trades ────────────────────────────────────────────────────────────────
-- Full trade ledger — persists across Railway redeploys.
-- Replaces the ephemeral trades.csv as the source of truth.
CREATE TABLE IF NOT EXISTS bot_trades (
  id              bigserial PRIMARY KEY,
  timestamp       timestamptz NOT NULL,
  symbol          text        NOT NULL,
  side            text        NOT NULL CHECK (side IN ('buy', 'sell')),
  price_aud       numeric,
  quantity        numeric,
  total_aud       numeric,
  pnl             numeric,         -- sell records only: gross AUD profit/loss
  exit_reasons    text,            -- sell records only: why exit fired
  order_id        text,
  mode            text CHECK (mode IN ('LIVE', 'PAPER')),
  score           integer,         -- buy records only: confluence score (0-8)
  stop_loss_aud   numeric,         -- buy records only
  take_profit_aud numeric,         -- buy records only
  atr             numeric          -- ATR(14) in USDT at entry
);

CREATE INDEX IF NOT EXISTS idx_bot_trades_symbol    ON bot_trades (symbol);
CREATE INDEX IF NOT EXISTS idx_bot_trades_timestamp ON bot_trades (timestamp);
CREATE INDEX IF NOT EXISTS idx_bot_trades_side      ON bot_trades (side);

-- ── bot_positions ─────────────────────────────────────────────────────────────
-- Open position ownership — the source of truth for what the bot owns.
-- Prevents the bot from ever touching pre-existing Kraken balances.
-- One row per symbol; upserted on buy, patched (is_open=false) on sell.
CREATE TABLE IF NOT EXISTS bot_positions (
  id                bigserial PRIMARY KEY,
  symbol            text        UNIQUE NOT NULL,
  entry_price_aud   numeric     NOT NULL,  -- AUD fill price (for P&L display)
  entry_price_usdt  numeric     NOT NULL,  -- USDT-equivalent at entry (for stop/TP logic)
  entry_time        timestamptz NOT NULL,
  quantity          numeric     NOT NULL,  -- base currency units (e.g. 0.001 BTC)
  stop_loss_usdt    numeric     NOT NULL,  -- hard stop in USDT (entry − 1.5×ATR)
  take_profit_usdt  numeric     NOT NULL,  -- TP in USDT (entry + 3×ATR)
  order_id          text,                  -- Kraken txid of the buy order
  mode              text CHECK (mode IN ('LIVE', 'PAPER')),
  is_open           boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_positions_symbol  ON bot_positions (symbol);
CREATE INDEX IF NOT EXISTS idx_bot_positions_is_open ON bot_positions (is_open);

-- ── Enable Row Level Security (RLS) ──────────────────────────────────────────
-- The bot uses the anon/service key — allow full access via that key.
-- Adjust these policies if you add a frontend or other consumers.

ALTER TABLE bot_state     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_trades    ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_positions ENABLE ROW LEVEL SECURITY;

-- Allow all operations from authenticated service role (Railway uses anon key with full access)
CREATE POLICY "bot full access" ON bot_state     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "bot full access" ON bot_trades    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "bot full access" ON bot_positions FOR ALL USING (true) WITH CHECK (true);

-- ── Verification query — run after setup to confirm tables exist ──────────────
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_name IN ('bot_state', 'bot_trades', 'bot_positions');
