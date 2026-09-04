/**
 * Compromised / drained wallet addresses.
 *
 * Mirrors the blacklist table in the operator's `CLAUDE.md`. Every one of
 * these is a public address whose private key is known to be leaked, or an
 * attacker aggregation address. Sending to any of them is an irreversible
 * loss: sweepers are assumed active on the leaked ones.
 *
 * These are PUBLIC addresses only. No key material, no mnemonic, no .env
 * value ever appears in this file or in this skill.
 *
 * Matching is case-insensitive and whitespace-trimmed, because EVM addresses
 * are commonly written in mixed checksum case and Stellar/Solana/Tron
 * addresses get copied with stray spaces.
 *
 * Keep this list append-only. Removing an entry requires the owner to say so.
 */

export interface BlacklistEntry {
  address: string;
  chain: string;
  note: string;
}

export const COMPROMISED_ADDRESSES: BlacklistEntry[] = [
  { address: "GD2UZOA5RFWILHTPQL6CDTLIT6XPEGZQXJX4NWQC7ZU7DCEXK5NSQ2GH", chain: "stellar", note: "reported compromised 2026-05-24" },
  { address: "0x8FE7155119d2975780c9e19B07dD98393965Bc2a", chain: "evm", note: "drained 2026-06-26" },
  { address: "0xa9E3Da13EF5eADFC6EcB2BB6BDddE95016B567dB", chain: "evm", note: "drained 2026-06-26" },
  { address: "0x5772FBe7a7817ef7F586215CA8b23b8dD22C8897", chain: "evm", note: "drained 2026-06-26; sweeper active" },
  { address: "AEEtekA2EBYVy3e5Xx8fD3GkjWSoCsLvLzdD6pZTgHiH", chain: "solana", note: "drained 2026-06-26" },
  { address: "TBcegJf63xa5r7hi5jmqSsTnSEAAFkUcGu", chain: "tron", note: "drained 2026-06-26" },
  { address: "0x44d6B5a11FFc5Ba1043734d88af5E5dea36a648A", chain: "evm", note: "drained 2026-06-26" },
  { address: "0x467AeD16d024405116cF4Ba12976Bf63B404517b", chain: "evm", note: "drained 2026-06-26" },
  { address: "a23F2uanwzTDtWJmPK1y1DiKbnR7vCNZTqdQEacRz8W", chain: "solana", note: "drained 2026-06-26" },
  { address: "0xF621Ee3BaE3cbE924Ec05f795d14E31384Bd11b6", chain: "evm", note: "attacker aggregation address — do not interact" },
  { address: "9Ms2FNXMY9ucKwzxcnGxvqMcfSkBhRdPZhrsj1Ui1KiN", chain: "solana", note: "attacker aggregation address — do not interact" },
  { address: "0x49CD5655Cc9bf7c7C93fBb2DF36AA3020d11eEe0", chain: "evm", note: "leaked E2E test wallet 2026-07-03" },
  { address: "EHhTSkqPpu4TENNpdyLewgxaMckSUke3c9hoNVu6zNMA", chain: "solana", note: "leaked E2E test wallet 2026-07-03" },
  { address: "He9F3sHpDLN1br4Ts7AHpqQbGZaDkqgu2QK6dw93RpAk", chain: "solana", note: "leaked E2E test wallet 2026-07-03" },
  { address: "GAN3YSPDH5VW7YFJJFUJH7LIYTJBWGH3GJMKOG6FP5RKHXGNMPX44UYY", chain: "stellar", note: "leaked E2E test wallet 2026-07-03" },
  { address: "TE78sm1mFajxtPjKMWQkLQTaBKQVqJVum4", chain: "tron", note: "leaked TronLink wallet 2026-07-09" },
  { address: "0xa9BacE1614d6cFf8aa159A2A41eE8BaA9a91Cc7B", chain: "evm", note: "rozo-cctp operator hot wallet, key leaked 2026-07-15" },
  { address: "0xfD0e6fA2ABA8436e95f3Fb3523AC14Ba299c0e79", chain: "evm", note: "MugglePay flusher gas payer, compromised 2026-06-26" },
  { address: "GAIK5OR2FY4MVXVL4AZDJLAJT3MIJ5I6PAYARB2CATRRVACWFI7C6NHW", chain: "stellar", note: "plaintext seed leaked 2026-08-09; account merged away, never fund again" },
  { address: "GBQHLQMEPMBQEVFQXFAQ7EW54IVIC7VBGLTBCUJSRV7RUL7YAZ2CJ2IA", chain: "stellar", note: "suspected leaked gas sponsor, rotated out 2026-08-24" },
];

const INDEX = new Map<string, BlacklistEntry>(
  COMPROMISED_ADDRESSES.map((e) => [e.address.trim().toLowerCase(), e]),
);

/** Return the blacklist entry for an address, or null when it is not listed. */
export function lookupBlacklist(address: string | null | undefined): BlacklistEntry | null {
  if (!address) return null;
  return INDEX.get(address.trim().toLowerCase()) ?? null;
}

/** Mask an address for logs: first 6 + last 4, per the house display rule. */
export function maskAddress(address: string): string {
  const a = address.trim();
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}
