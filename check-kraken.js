/**
 * check-kraken.js — prints current Kraken account balance
 * Run via: railway run node check-kraken.js
 */

import "dotenv/config";
import crypto from "crypto";

function sign(path, nonce, postData) {
  const secret = Buffer.from(process.env.KRAKEN_API_SECRET, "base64");
  const hash   = crypto.createHash("sha256").update(nonce + postData).digest("binary");
  return crypto.createHmac("sha512", secret).update(path + hash, "binary").digest("base64");
}

async function krakenPrivate(path, params = {}) {
  const nonce    = Date.now().toString();
  const postData = new URLSearchParams({ nonce, ...params }).toString();
  const res = await fetch(`https://api.kraken.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "API-Key":  process.env.KRAKEN_API_KEY,
      "API-Sign": sign(path, nonce, postData),
    },
    body: postData,
  });
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(data.error.join(", "));
  return data.result;
}

async function fetchPrice(pair) {
  const res  = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
  const data = await res.json();
  if (data.error?.length > 0) return null;
  return parseFloat(Object.values(data.result)[0].c[0]);
}

const AUD_PAIRS = {
  XXBT: "XBTAUD", XETH: "ETHAUD", SOL: "SOLAUD",
  XXRP: "XRPAUD", XXDG: "XDGAUD", LINK: "LINKUSD",
  ADA: "ADAAUD",  SUI: "SUIUSD",  AVAX: "AVAXUSD",
  PEPE: "PEPEUSD",
};

const balances = await krakenPrivate("/0/private/Balance");
const audCash  = parseFloat(balances["ZAUD"] || balances["AUD"] || "0");

console.log("\n═══════════════════════════════");
console.log("  Kraken Account Balance");
console.log("═══════════════════════════════");
console.log(`\n  💵 AUD Cash:  $${audCash.toFixed(2)}\n`);

let totalAUD = audCash;

for (const [asset, qty] of Object.entries(balances)) {
  if (asset === "ZAUD" || asset === "AUD") continue;
  const amount = parseFloat(qty);
  if (amount <= 0) continue;

  const pair  = AUD_PAIRS[asset];
  const price = pair ? await fetchPrice(pair) : null;
  const value = price ? amount * price : null;
  if (value !== null) totalAUD += value;

  const qtyStr = amount >= 1_000_000
    ? amount.toLocaleString("en-AU", { maximumFractionDigits: 0 })
    : amount < 1 ? amount.toFixed(6) : amount.toFixed(4);

  const valStr = value !== null ? `  ≈ $${value.toFixed(2)} AUD` : "";
  const priceStr = price !== null ? `  @ $${price.toFixed(price < 0.01 ? 8 : 2)}` : "";
  console.log(`  ${asset.padEnd(6)}  ${qtyStr}${priceStr}${valStr}`);
}

console.log(`\n  ─────────────────────────────`);
console.log(`  Total (est.):  $${totalAUD.toFixed(2)} AUD`);
console.log("═══════════════════════════════\n");
