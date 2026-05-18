/**
 * recalibrate.js — Weekly Supabase-driven strategy recalibration
 *
 * Cron: 0 22 * * 0  (Sunday 22:00 UTC — just before the weekly liquidity hole ends)
 * Railway service: add a separate service pointing to this file.
 *
 * What it does:
 *   1. Queries bot_trades for the last 14 days, grouped by score and symbol.
 *   2. If a score bucket has ≥10 trades and negative total P&L → bumps
 *      min_confluence_score by 1 in bot_state (capped at 8).
 *   3. If a symbol has ≥10 trades and negative total P&L → Telegrams a
 *      recommendation to remove it from SYMBOLS (does not auto-remove —
 *      Railway API key not required).
 *   4. Telegrams a full recalibration summary.
 */

import "dotenv/config";
import { sendTelegram } from "./debrief.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function supabaseHeaders() {
  return {
    "Content-Type":  "application/json",
    "apikey":        SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
  };
}

function supabaseReady() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

async function supabaseSelect(table, filter, select = "*") {
  if (!supabaseReady()) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}&select=${select}`, {
      headers: supabaseHeaders(),
    });
    return await res.json();
  } catch {
    return null;
  }
}

async function supabaseUpsert(table, row, conflictCol) {
  if (!supabaseReady()) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictCol}`, {
      method:  "POST",
      headers: { ...supabaseHeaders(), "Prefer": "resolution=merge-duplicates,return=minimal" },
      body:    JSON.stringify(row),
    });
  } catch (err) {
    console.log(`  ⚠️  Supabase upsert(${table}): ${err.message}`);
  }
}

export async function runRecalibration() {
  if (!supabaseReady()) {
    console.log("⚠️  Supabase not configured — recalibration skipped");
    return;
  }

  const mode          = process.env.PAPER_TRADING !== "false" ? "PAPER" : "LIVE";
  const fourteenAgo   = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const actions       = [];

  console.log(`\n══ Recalibration — ${new Date().toISOString()} ══\n`);

  // ── 1. Fetch last 14 days of closed trades ────────────────────────────
  const trades = await supabaseSelect(
    "bot_trades",
    `timestamp=gte.${fourteenAgo}&side=eq.sell&mode=eq.${mode}`,
    "symbol,score,pnl"
  );

  if (!trades || trades.length === 0) {
    console.log("  No closed trades in last 14 days — nothing to recalibrate");
    return;
  }

  // ── 2. Performance by score bucket ───────────────────────────────────
  const byScore = {};
  for (const t of trades) {
    const s = t.score ?? "unknown";
    if (!byScore[s]) byScore[s] = { count: 0, totalPnl: 0 };
    byScore[s].count++;
    byScore[s].totalPnl += parseFloat(t.pnl) || 0;
  }

  console.log("  Performance by score:");
  for (const [score, stats] of Object.entries(byScore).sort(([a], [b]) => Number(a) - Number(b))) {
    console.log(`    score ${score}: ${stats.count} trades | P&L ${stats.totalPnl >= 0 ? "+" : ""}${stats.totalPnl.toFixed(2)} AUD`);
  }

  // Read current min_confluence_score
  const scoreRow    = await supabaseSelect("bot_state", "key=eq.min_confluence_score", "value");
  let   currentMin  = scoreRow?.[0]?.value ? parseInt(scoreRow[0].value) : 6;
  if (isNaN(currentMin)) currentMin = 6;

  // Bump if any score bucket with ≥10 trades is in the red
  for (const [score, stats] of Object.entries(byScore)) {
    const s = parseInt(score);
    if (isNaN(s)) continue;
    if (stats.count >= 10 && stats.totalPnl < 0 && s <= currentMin) {
      const newMin = Math.min(currentMin + 1, 8);
      await supabaseUpsert("bot_state", {
        key:        "min_confluence_score",
        value:      newMin.toString(),
        updated_at: new Date().toISOString(),
      }, "key");
      const msg = `📈 Recalibration: min_confluence_score bumped ${currentMin} → ${newMin}\nScore ${s} had ${stats.count} trades and ${stats.totalPnl.toFixed(2)} AUD P&L over 14 days.`;
      actions.push(msg);
      console.log(`  ⬆️  ${msg}`);
      currentMin = newMin;
      break; // one bump per run
    }
  }

  // ── 3. Performance by symbol ──────────────────────────────────────────
  const bySymbol = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { count: 0, totalPnl: 0 };
    bySymbol[t.symbol].count++;
    bySymbol[t.symbol].totalPnl += parseFloat(t.pnl) || 0;
  }

  console.log("\n  Performance by symbol:");
  for (const [sym, stats] of Object.entries(bySymbol).sort((a, b) => a[1].totalPnl - b[1].totalPnl)) {
    const flag = stats.count >= 10 && stats.totalPnl < 0 ? " ⚠️ UNDERPERFORMING" : "";
    console.log(`    ${sym}: ${stats.count} trades | P&L ${stats.totalPnl >= 0 ? "+" : ""}${stats.totalPnl.toFixed(2)} AUD${flag}`);
    if (stats.count >= 10 && stats.totalPnl < 0) {
      const msg = `⚠️ ${sym} underperforming: ${stats.count} trades, ${stats.totalPnl.toFixed(2)} AUD P&L over 14 days.\nRecommendation: remove from SYMBOLS in Railway env vars.`;
      actions.push(msg);
    }
  }

  // ── 4. Telegram summary ───────────────────────────────────────────────
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.log("\n  ⚠️  No Telegram credentials — skipping notification");
    return;
  }

  const lines = [
    `<b>🔧 Weekly Recalibration — ${new Date().toISOString().slice(0, 10)}</b>`,
    `Mode: ${mode} | Trades analysed: ${trades.length} (last 14 days)`,
    `Min confluence score: <b>${currentMin}/8</b>`,
    "",
  ];

  if (actions.length === 0) {
    lines.push("<i>No changes needed — strategy performing within acceptable range.</i>");
  } else {
    lines.push("<b>Actions taken / recommended:</b>");
    lines.push(...actions.map((a) => `• ${a}`));
  }

  lines.push("\n<b>Symbol P&L (14d):</b>");
  for (const [sym, stats] of Object.entries(bySymbol).sort((a, b) => a[1].totalPnl - b[1].totalPnl)) {
    const sign = stats.totalPnl >= 0 ? "+" : "";
    lines.push(`${sym}: ${sign}${stats.totalPnl.toFixed(2)} AUD (${stats.count} trades)`);
  }

  try {
    await sendTelegram(lines.join("\n"));
    console.log("\n  ✅ Telegram recalibration report sent");
  } catch (err) {
    console.log(`\n  ⚠️  Telegram send failed: ${err.message}`);
  }
}

if (process.argv[1]?.includes("recalibrate")) {
  runRecalibration().catch((err) => { console.error("Recalibration error:", err); process.exit(1); });
}
