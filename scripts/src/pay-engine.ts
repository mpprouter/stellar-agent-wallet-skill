/**
 * Pay-per-call engine — pure library that orchestrates:
 *   1. Initial fetch
 *   2. Parse 402 challenge (x402 or MPP dialect)
 *   3. Sign the inner XDR
 *   4. Retry with the payment header
 *
 * All configuration (network, rpcUrl, secret) is passed in via
 * `SignerConfig` from the caller. This module takes no external state
 * and is a pure library.
 */

import { signSacTransfer, type SignerConfig } from "./stellar-signer.js";
import { encodeX402Header, wrapX402, assertSponsored } from "./x402.js";
import { encodeMppHeader, type MppChallenge } from "./mpp-envelope.js";

export interface ParsedChallenge {
  dialect: "x402" | "mpp";
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  raw: unknown;
}

/**
 * Parse a 402 response into a structured challenge.
 *
 * Priority order when a server emits multiple dialects (MPP Router does
 * this — it emits both in parallel, each routed to a different payTo
 * address via HMAC-bound credentials). We always pick MPP first:
 *
 *   1. MPP dialect — `WWW-Authenticate: Payment request="<base64>"` header
 *   2. x402 dialect — `Payment-Required: <base64>` response header
 *      (x402 v2 spec — this is the current MPP Router shape)
 *   3. x402 legacy — `accepts[]` envelope inside the JSON response body
 *      (older x402 servers)
 *
 * See skills/pay-per-call/SKILL.md for the rationale.
 */
export async function parse402(res: Response): Promise<ParsedChallenge | null> {
  // 1. MPP dialect — WWW-Authenticate: Payment <auth-params>.
  //
  // The server emits a full RFC 7235 challenge with id, realm, method,
  // intent, request, expires, opaque params. We parse all of them so
  // `encodeMppHeader` can echo the challenge back intact (the HMAC
  // binding on `id` requires the full challenge round-trip).
  const wwwAuth = res.headers.get("www-authenticate");
  if (wwwAuth) {
    const mppChallenge = parseMppChallengeFromWwwAuthenticate(wwwAuth);
    if (mppChallenge) {
      return {
        dialect: "mpp",
        amount: mppChallenge.request.amount,
        asset: mppChallenge.request.currency,
        payTo: mppChallenge.request.recipient,
        maxTimeoutSeconds:
          (mppChallenge.request.methodDetails?.maxTimeoutSeconds as
            | number
            | undefined) ?? 60,
        raw: mppChallenge,
      };
    }
  }

  // 2. x402 v2 dialect — Payment-Required response header.
  //    MPP Router emits this alongside the application/problem+json body.
  //    The header value is a base64-encoded x402 envelope
  //    { x402Version, error, accepts: [PaymentRequirements, ...] }.
  const paymentRequiredHeader = res.headers.get("payment-required");
  if (paymentRequiredHeader) {
    try {
      const decoded = Buffer.from(paymentRequiredHeader, "base64").toString(
        "utf8",
      );
      const body = JSON.parse(decoded);
      if (body?.accepts?.[0]?.scheme === "exact") {
        const r = body.accepts[0];
        assertSponsored(r);
        return {
          dialect: "x402",
          amount: r.amount,
          asset: r.asset,
          payTo: r.payTo,
          maxTimeoutSeconds: r.maxTimeoutSeconds ?? 60,
          raw: body,
        };
      }
    } catch {
      // header present but not a decodable x402 envelope — fall through
    }
  }

  // 3. x402 legacy dialect — envelope inside JSON response body.
  try {
    const body: any = await res.clone().json();
    if (body?.accepts?.[0]?.scheme === "exact") {
      const r = body.accepts[0];
      assertSponsored(r);
      return {
        dialect: "x402",
        amount: r.amount,
        asset: r.asset,
        payTo: r.payTo,
        maxTimeoutSeconds: r.maxTimeoutSeconds ?? 60,
        raw: body,
      };
    }
  } catch {
    // not JSON
  }

  return null;
}

/**
 * Parse a `WWW-Authenticate: Payment <auth-params>` header into a
 * structured MPP challenge.
 *
 * Handles the RFC 7235 `Payment` scheme with auth-params:
 *   id="...", realm="...", method="stellar", intent="charge",
 *   request="<base64url-json>", expires="...", opaque="<base64url-json>"
 *
 * Both `request` and `opaque` are nested base64url-encoded JSON objects
 * and are decoded into structured values so the credential can echo
 * them back to satisfy the HMAC binding on `challenge.id`.
 *
 * Returns `null` if the header is not a Payment challenge or is missing
 * the required `request` param.
 */
function parseMppChallengeFromWwwAuthenticate(
  header: string,
): MppChallenge | null {
  // The header may contain multiple comma-separated schemes (RFC 9110).
  // Find the first `Payment <...>` span.
  const paymentSection = extractPaymentScheme(header);
  if (!paymentSection) return null;

  const params = parseAuthParams(paymentSection);
  const rawRequest = params["request"];
  if (!rawRequest) return null;

  let request: MppChallenge["request"];
  try {
    request = JSON.parse(
      Buffer.from(rawRequest, "base64url").toString("utf8"),
    ) as MppChallenge["request"];
  } catch {
    return null;
  }

  let opaque: Record<string, string> | undefined;
  if (params["opaque"]) {
    try {
      opaque = JSON.parse(
        Buffer.from(params["opaque"], "base64url").toString("utf8"),
      ) as Record<string, string>;
    } catch {
      // Tolerate malformed opaque — it's optional.
    }
  }

  const id = params["id"];
  const realm = params["realm"];
  const method = params["method"];
  const intent = params["intent"];
  if (!id || !realm || !method || !intent) return null;

  return {
    id,
    realm,
    method,
    intent,
    request,
    ...(params["expires"] && { expires: params["expires"] }),
    ...(params["description"] && { description: params["description"] }),
    ...(params["digest"] && { digest: params["digest"] }),
    ...(opaque && { opaque }),
  };
}

/**
 * Extract the `Payment` scheme from a WWW-Authenticate value that may
 * contain multiple schemes (comma-separated per RFC 9110). Returns
 * the auth-params portion (everything after `Payment `), or null if
 * no Payment scheme is present.
 */
function extractPaymentScheme(header: string): string | null {
  // Walk the header respecting quoted-strings so commas inside values
  // don't split schemes.
  const token = "Payment";
  let inQuotes = false;
  let escaped = false;

  for (let i = 0; i < header.length; i++) {
    const char = header[i]!;
    if (inQuotes) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inQuotes = false;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    // Match `Payment ` at a scheme boundary (start of string or after comma).
    if (
      header.slice(i, i + token.length).toLowerCase() === token.toLowerCase() &&
      /\s/.test(header[i + token.length] ?? "")
    ) {
      const prefix = header.slice(0, i).trimEnd();
      if (prefix === "" || prefix.endsWith(",")) {
        let start = i + token.length;
        while (start < header.length && /\s/.test(header[start] ?? "")) start++;
        return header.slice(start);
      }
    }
  }
  return null;
}

/**
 * Parse auth-params from a scheme body (the part after `Payment `).
 * Supports both quoted-string and token values per RFC 7235.
 */
function parseAuthParams(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  let i = 0;

  while (i < input.length) {
    // Skip whitespace and commas between params.
    while (i < input.length && /[\s,]/.test(input[i] ?? "")) i++;
    if (i >= input.length) break;

    // Read key (token chars).
    const keyStart = i;
    while (i < input.length && /[A-Za-z0-9_-]/.test(input[i] ?? "")) i++;
    const key = input.slice(keyStart, i);
    if (!key) break;

    while (i < input.length && /\s/.test(input[i] ?? "")) i++;
    if (input[i] !== "=") break;
    i++;
    while (i < input.length && /\s/.test(input[i] ?? "")) i++;

    // Read value — quoted or token.
    let value: string;
    if (input[i] === '"') {
      i++;
      let v = "";
      let escaped = false;
      while (i < input.length) {
        const ch = input[i]!;
        i++;
        if (escaped) {
          v += ch;
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') break;
        v += ch;
      }
      value = v;
    } else {
      const vStart = i;
      while (i < input.length && input[i] !== ",") i++;
      value = input.slice(vStart, i).trim();
    }

    result[key] = value;
  }

  return result;
}

/**
 * Build the request headers for the retry call after signing.
 *
 * The signed XDR gets wrapped in the appropriate envelope for the
 * detected 402 dialect and appended as either X-Payment (x402) or
 * Authorization: Payment (MPP).
 */
export async function buildRetryHeaders(params: {
  challenge: ParsedChallenge;
  signerConfig: SignerConfig;
  baseHeaders?: HeadersInit;
}): Promise<Headers> {
  const { challenge, signerConfig, baseHeaders } = params;

  const signed = await signSacTransfer(signerConfig, {
    assetSac: challenge.asset,
    payTo: challenge.payTo,
    amountBaseUnits: challenge.amount,
    maxTimeoutSeconds: challenge.maxTimeoutSeconds,
  });

  const headers = new Headers(baseHeaders);
  if (challenge.dialect === "x402") {
    const caip2 =
      signerConfig.network === "pubnet" ? "stellar:pubnet" : "stellar:testnet";
    const x402Version = (challenge.raw as any)?.x402Version ?? 1;
    const payload = wrapX402(signed.transactionXdr, caip2, x402Version);
    headers.set("X-Payment", encodeX402Header(payload));
  } else {
    headers.set(
      "Authorization",
      encodeMppHeader(
        signed.transactionXdr,
        signed.signerPubkey,
        challenge.raw as MppChallenge,
      ),
    );
  }
  return headers;
}

/** Convert a base-units i128 string to a human USDC decimal (7 decimals). */
export function baseUnitsToUsdc(amount: string): string {
  return (Number(amount) / 10_000_000).toFixed(7);
}
