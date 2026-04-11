/**
 * Generate a fresh Stellar keypair for an agent wallet.
 *
 * Usage:
 *   npx tsx scripts/generate-keypair.ts
 *
 * Prints the public key and secret. Store the secret in .env as STELLAR_SECRET.
 * Fund the public key via Friendbot (testnet) before first use.
 */

import { Keypair } from "@stellar/stellar-sdk";

const kp = Keypair.random();

console.log("Stellar keypair generated:");
console.log("  Public key: " + kp.publicKey());
console.log("  Secret:     " + kp.secret());
console.log("");
console.log("Next steps:");
console.log("  1. Add to .env:  STELLAR_SECRET=" + kp.secret());
console.log("  2. Fund testnet: curl 'https://friendbot.stellar.org?addr=" + kp.publicKey() + "'");
console.log("  3. For USDC, swap XLM on a testnet DEX or ask your server operator.");
