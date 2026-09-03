/**
 * pay-link URL whitelist.
 *
 * This skill deliberately does NOT implement a general "fetch any URL and
 * figure out how to pay it" crawler. That is the single most dangerous shape
 * an agent payment tool can take: a blind fetcher turns any link anyone can
 * get in front of the agent into a signing prompt.
 *
 * Instead: three exact host + path shapes, one per provider we have a real
 * read-only inspector for. Anything else is refused by name, with the list of
 * what is accepted, and nothing is fetched.
 */

import type { Provider } from "./types.js";

interface Pattern {
  provider: Provider;
  /** Exact hostnames (lowercased, no port) this pattern accepts. */
  hosts: string[];
  /** Path must match this. */
  path: RegExp;
  /** Human description used in refusal messages. */
  describe: string;
}

/**
 * Coinbase ships two URL families and both are live; the pay-coinbase skill
 * parses both, so both stay whitelisted here (legacy payment-links and v3
 * payment-sessions).
 */
const PATTERNS: Pattern[] = [
  {
    provider: "coinbase",
    hosts: ["payments.coinbase.com"],
    path: /^\/payment-links\/pl_[A-Za-z0-9_-]+\/?$/,
    describe: "https://payments.coinbase.com/payment-links/pl_…",
  },
  {
    provider: "coinbase",
    hosts: ["payments.coinbase.com"],
    path: /^\/payment-sessions\/paymentSession_[A-Za-z0-9_-]+\/?$/,
    describe: "https://payments.coinbase.com/payment-sessions/paymentSession_…",
  },
  {
    provider: "stripe-crypto",
    hosts: ["crypto.stripe.com"],
    path: /^\/pay\/[A-Za-z0-9_-]+\/?$/,
    describe: "https://crypto.stripe.com/pay/…",
  },
  {
    provider: "rozo-intent",
    hosts: ["invoice.rozo.ai", "pay.mugglepay.com"],
    path: /^\/checkout\/?$/,
    describe: "https://invoice.rozo.ai/checkout?id=…",
  },
];

export class UnsupportedLinkError extends Error {
  readonly code = "unsupported_link";
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface ResolvedLink {
  provider: Provider;
  /**
   * **Canonical** URL: scheme + host + path, plus only the query parameters
   * that identify the invoice. The fragment and every other query parameter
   * are dropped.
   *
   * This matters beyond tidiness. The fragment is never sent to the server, so
   * `.../pl_123#a` and `.../pl_123#b` are the same invoice — but if the raw
   * string reached the confirmation digest and the idempotency key, they would
   * hash differently, and a second run under a different fragment (or a
   * tracking parameter) would sail past the "already paid" check.
   */
  url: string;
  /** Provider-native id pulled out of the URL. */
  reference: string;
  /**
   * `provider:reference` — the identity of the *invoice*, independent of how
   * its URL was written. This, not the URL, is what idempotency is keyed on.
   */
  canonicalKey: string;
}

/** The accepted shapes, for help text and refusal messages. */
export function supportedShapes(): string[] {
  return PATTERNS.map((p) => p.describe);
}

/**
 * Classify a URL against the whitelist.
 *
 * Throws `UnsupportedLinkError` — never falls back to "try fetching it anyway".
 */
export function resolveLink(raw: string): ResolvedLink {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsupportedLinkError(`not a URL: ${raw}`);
  }

  // http:// would let a network attacker rewrite an invoice in flight.
  if (u.protocol !== "https:") {
    throw new UnsupportedLinkError(
      `only https:// links are accepted (got ${u.protocol}//)`,
    );
  }
  // Credentials in a URL are a phishing tell and confuse host comparison.
  if (u.username || u.password) {
    throw new UnsupportedLinkError("URLs with embedded credentials are refused");
  }

  // `hostname` excludes the port, so an alternate port would otherwise sail
  // through the host check and let us POST at some unrelated service listening
  // on e.g. payments.coinbase.com:444. The whitelist means the canonical
  // HTTPS endpoint, nothing else on that host.
  if (u.port && u.port !== "443") {
    throw new UnsupportedLinkError(
      `only the default HTTPS port is accepted (got port ${u.port})`,
    );
  }

  const host = u.hostname.toLowerCase();
  for (const p of PATTERNS) {
    if (!p.hosts.includes(host)) continue;
    if (!p.path.test(u.pathname)) continue;

    const path = u.pathname.replace(/\/$/, "");

    if (p.provider === "rozo-intent") {
      const id = u.searchParams.get("id");
      if (!id || !/^[A-Za-z0-9_-]{6,}$/.test(id)) {
        throw new UnsupportedLinkError(
          "Rozo checkout link is missing a usable ?id= parameter",
        );
      }
      // Only `id` survives: it is the whole of the invoice's identity here.
      return {
        provider: p.provider,
        url: `https://${host}${path}?id=${encodeURIComponent(id)}`,
        reference: id,
        canonicalKey: `${p.provider}:${id}`,
      };
    }

    // Coinbase and Stripe carry the id in the path; nothing in the query
    // identifies the invoice, so the query goes entirely.
    const seg = path.split("/").pop() ?? "";
    return {
      provider: p.provider,
      url: `https://${host}${path}`,
      reference: seg,
      canonicalKey: `${p.provider}:${seg}`,
    };
  }

  throw new UnsupportedLinkError(
    `${host}${u.pathname} is not a payment link this skill knows how to read. ` +
      `Accepted: ${supportedShapes().join(" | ")}. ` +
      `This skill has no generic URL fetcher on purpose.`,
  );
}
