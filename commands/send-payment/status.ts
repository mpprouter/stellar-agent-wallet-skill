/**
 * send-payment/status — poll a Rozo payment ID until complete.
 *
 * Endpoint: GET https://intentapiv4.rozo.ai/functions/v1/payment-api/payments/{id}
 *
 * Usage:
 *   npx tsx commands/send-payment/status.ts <payment-id>
 *   npx tsx commands/send-payment/status.ts <payment-id> --watch
 */

import "dotenv/config";

const STATUS_MEANINGS: Record<string, string> = {
  payment_unpaid: "Created, awaiting funding",
  payment_started: "Funding detected, processing",
  payment_payin_completed: "Source funds received",
  payment_payout_completed: "Destination funds sent",
  payment_completed: "Fully complete",
  payment_bounced: "Payout failed",
  payment_expired: "Not funded in time",
  payment_refunded: "Funds returned to sender",
};

const TERMINAL = new Set([
  "payment_completed",
  "payment_bounced",
  "payment_expired",
  "payment_refunded",
]);

async function fetchStatus(id: string) {
  const baseUrl =
    process.env.ROZO_INTENT_URL ??
    "https://intentapiv4.rozo.ai/functions/v1/payment-api";
  const res = await fetch(`${baseUrl}/payments/${id}`);
  if (!res.ok) throw new Error(`Status fetch failed: ${res.status} ${res.statusText}`);
  return await res.json();
}

function render(data: any) {
  console.log(`Payment: ${data.id}`);
  console.log(`  Status:   ${data.status} — ${STATUS_MEANINGS[data.status] ?? "unknown"}`);
  console.log(`  Type:     ${data.type}`);
  console.log(`  Created:  ${data.createdAt}`);
  console.log(`  Expires:  ${data.expiresAt}`);
  console.log("");
  console.log(`  Source:      ${data.source?.tokenSymbol} on chain ${data.source?.chainId}`);
  console.log(`    Amount:    ${data.source?.amount}`);
  console.log(`    Deposit:   ${data.source?.receiverAddress}`);
  if (data.source?.receiverMemo) {
    console.log(`    Memo:      ${data.source?.receiverMemo}`);
  }
  if (data.source?.fee) {
    console.log(`    Fee:       ${data.source?.fee}`);
  }
  console.log("");
  console.log(`  Destination: ${data.destination?.tokenSymbol} on chain ${data.destination?.chainId}`);
  console.log(`    To:        ${data.destination?.receiverAddress}`);
  console.log(`    Amount:    ${data.destination?.amount}`);
}

async function main() {
  const id = process.argv[2];
  const watch = process.argv.includes("--watch");
  if (!id) {
    console.error("Usage: status.ts <payment-id> [--watch]");
    process.exit(1);
  }

  if (!watch) {
    const data = await fetchStatus(id);
    render(data);
    return;
  }

  // Watch mode — poll every 5s until terminal
  while (true) {
    const data = await fetchStatus(id);
    console.clear();
    render(data);
    console.log("");
    console.log("(watching — Ctrl+C to stop)");
    if (TERMINAL.has(data.status)) {
      console.log("");
      console.log("✅ Reached terminal state.");
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
