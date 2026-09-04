/**
 * Chain-aware address handling.
 *
 * Case folding is NOT universal. EVM addresses are hex and case-insensitive
 * (the mixed case is only an EIP-55 checksum). Stellar, Solana and Tron
 * addresses are base32/base58 where case is *significant* — two addresses that
 * differ only in case are two different accounts.
 *
 * So a single `toLowerCase()` comparison, which is the obvious thing to write,
 * silently makes `--expect-pay-to` accept a different Solana account. Every
 * equality check on an address goes through `sameAddress` instead.
 *
 * (The blacklist deliberately keeps matching case-insensitively: for a *deny*
 * list, matching more broadly than necessary is the safe direction.)
 */

export type AddressFamily = "evm" | "stellar" | "solana" | "tron" | "unknown";

/** Classify a chain identifier — name or numeric chain id — into a family. */
export function addressFamily(chain: string): AddressFamily {
  const c = chain.trim().toLowerCase();
  if (c === "stellar" || c === "1500") return "stellar";
  if (c === "tron" || c === "728126428") return "tron";
  if (c === "solana" || c === "792703809") return "solana";
  if (/^\d+$/.test(c)) return "evm";
  if (["base", "ethereum", "eth", "arbitrum", "polygon", "optimism", "bnb", "hyperevm"].includes(c)) {
    return "evm";
  }
  return "unknown";
}

/**
 * Compare two addresses on a given chain.
 *
 * EVM: case-insensitive. Everything else: exact, after trimming whitespace
 * only. An unknown family is compared exactly — the conservative choice, since
 * a false mismatch refuses a payment while a false match authorises one.
 */
export function sameAddress(chain: string, a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (addressFamily(chain) === "evm") return x.toLowerCase() === y.toLowerCase();
  return x === y;
}

/**
 * Loose shape check. Catches truncation, corruption, and an address pasted for
 * the wrong chain. Not a checksum validator.
 */
export function addressLooksValid(chain: string, address: string): boolean {
  const a = address.trim();
  switch (addressFamily(chain)) {
    case "stellar":
      return /^[GMC][A-Z2-7]{55}$/.test(a);
    case "tron":
      return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
    case "solana":
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
    case "evm":
      return /^0x[0-9a-fA-F]{40}$/.test(a);
    default:
      // Unknown chain naming: require something long enough not to be a stub.
      return a.length >= 20;
  }
}
