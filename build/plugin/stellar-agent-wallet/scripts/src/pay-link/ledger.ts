/**
 * Local spend ledger + idempotency store.
 *
 * Two jobs, one file:
 *
 *  1. **Rolling spend windows.** The daily and monthly ceilings in policy.ts
 *     need to know what has already been spent. Nothing else in this skill
 *     tracks that, so a small append-only local file does it.
 *
 *  2. **Idempotency.** A retry of the same link with the same confirmation
 *     digest must not pay twice. Entries are keyed by
 *     `(provider:reference, digest)` — the invoice's identity rather than the
 *     URL string, so a differing fragment or tracking parameter cannot buy a
 *     second payment — and re-running after a timeout or a crash replays the
 *     stored receipt instead of signing again.
 *
 * This is a local convenience file, not an authority: it lives beside the
 * wallet secret, holds no key material, and records only public facts
 * (invoice, digest, amount, tx hash). If it is deleted, the ceilings reset — which
 * is why the ceilings are a second line of defence behind the confirmation
 * digest, not the only one.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Receipt } from "./types.js";

export const DEFAULT_LEDGER_PATH = ".pay-link-ledger.json";

export interface LedgerEntry {
  key: string;
  /** `provider:reference` — see idempotencyKey(). */
  invoice: string;
  digest: string;
  amount: number;
  currency: string | null;
  status: Receipt["status"];
  tx_hash: string | null;
  at: string;
}

interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

/**
 * The idempotency key.
 *
 * Keyed on `provider:reference` + digest, **not** on the raw URL. Two URLs can
 * differ by a fragment or a tracking parameter and still be the same invoice;
 * keying on the string would let a second run under a cosmetically different
 * URL slip past the "already paid" check entirely.
 */
export function idempotencyKey(invoice: string, digest: string): string {
  return `${invoice}#${digest}`;
}

export function loadLedger(path = DEFAULT_LEDGER_PATH): LedgerFile {
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && Array.isArray(parsed.entries)) return parsed as LedgerFile;
  } catch {
    // A corrupt ledger must not silently reset the ceilings to zero.
    throw new Error(
      `Spend ledger at ${path} is unreadable. Fix or move it before paying — a missing ledger resets the daily/monthly ceilings.`,
    );
  }
  return { version: 1, entries: [] };
}

export function saveLedger(file: LedgerFile, path = DEFAULT_LEDGER_PATH): void {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Replace the last entry for an `(invoice, digest)` in place, or append it.
 *
 * Used to settle a reservation: the `pending` row written before execution
 * becomes `submitted`/`failed` afterwards, rather than leaving two rows that
 * both look like spend.
 */
export function settle(
  file: LedgerFile,
  invoice: string,
  digest: string,
  patch: Partial<Omit<LedgerEntry, "key" | "invoice" | "digest">>,
): LedgerFile {
  const key = idempotencyKey(invoice, digest);
  const entries = [...file.entries];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].key === key) {
      entries[i] = { ...entries[i], ...patch };
      return { ...file, entries };
    }
  }
  return file;
}

/** Previously recorded execution for this `(invoice, digest)`, if any. */
export function findEntry(
  file: LedgerFile,
  invoice: string,
  digest: string,
): LedgerEntry | null {
  const key = idempotencyKey(invoice, digest);
  // Last write wins: a retry that upgraded `submitted` → `confirmed` is newer.
  for (let i = file.entries.length - 1; i >= 0; i--) {
    if (file.entries[i].key === key) return file.entries[i];
  }
  return null;
}

/** Spend in the last 24h / 30d. Only entries that actually moved money count. */
export function spendWindows(
  file: LedgerFile,
  now = new Date(),
): { today: number; month: number } {
  const t = now.getTime();
  let today = 0;
  let month = 0;
  for (const e of file.entries) {
    // `pending` counts: a reservation means money may already have moved, so
    // it must consume the ceiling until it is reconciled. Only `dryrun`,
    // `refused` and `failed` are known not to have moved anything.
    if (e.status !== "submitted" && e.status !== "confirmed" && e.status !== "pending") continue;
    const at = Date.parse(e.at);
    if (Number.isNaN(at)) continue;
    const age = t - at;
    if (age <= 24 * 3600 * 1000) today += e.amount;
    if (age <= 30 * 24 * 3600 * 1000) month += e.amount;
  }
  return { today, month };
}

export function record(
  file: LedgerFile,
  entry: Omit<LedgerEntry, "key">,
): LedgerFile {
  return {
    ...file,
    entries: [...file.entries, { ...entry, key: idempotencyKey(entry.invoice, entry.digest) }],
  };
}
