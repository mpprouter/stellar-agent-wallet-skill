/**
 * MPP charge envelope encoder — pure library.
 *
 * Wraps a signed Stellar XDR as an `mppx.Credential` for the
 * `Authorization: Payment <base64url-json>` header.
 *
 * Wire shape (matches the mppx library — see Credential.ts / Challenge.ts
 * in the `mppx` package for the authoritative spec):
 *
 *     {
 *       challenge: {                          // full challenge echoed back
 *         id, realm, method, intent,
 *         request: <canonicalized base64url of request>,
 *         [expires], [description], [digest],
 *         [opaque: <canonicalized base64url of opaque>]
 *       },
 *       payload: { type: "transaction", transaction: <base64 XDR> },
 *       source: `did:pkh:${network}:${pubkey}`
 *     }
 *
 * The whole thing is then `JSON.stringify` + base64url (no padding).
 *
 * Critical details:
 *  - Both `request` and `opaque` are re-serialized via RFC 8785
 *    canonicalize (sorted keys, no whitespace) so the HMAC binding on
 *    `challenge.id` survives the client round-trip.
 *  - `source` DID uses the network string as received (e.g. `stellar:pubnet`);
 *    do NOT prepend `stellar:` — the network already carries the chain name.
 *  - `payload` is a DISCRIMINATED UNION of `{ type: "transaction", transaction }`
 *    or `{ type: "hash", hash }`. We only emit the `transaction` variant
 *    because this skill's signer always produces a signed XDR for the
 *    sponsored (pull) flow.
 */

/**
 * Parsed MPP challenge — mirrors `mppx.Challenge.Challenge` after
 * `request` and `opaque` have been base64url-decoded into structured
 * objects. This is what `parse402()` puts into `ParsedChallenge.raw`
 * and what `encodeMppHeader()` consumes.
 */
export interface MppChallenge {
  /** HMAC-bound challenge ID from the server. */
  id: string;
  /** Server realm (hostname). */
  realm: string;
  /** Payment method (e.g. `"stellar"`). */
  method: string;
  /** Intent type (e.g. `"charge"`). */
  intent: string;
  /** Method-specific request payload (decoded from the base64url `request` auth-param). */
  request: MppChargeRequest;
  /** Optional ISO 8601 expiration timestamp. */
  expires?: string;
  /** Optional human-readable description. */
  description?: string;
  /** Optional request body digest (`sha-256=<base64>`). */
  digest?: string;
  /** Optional server-defined correlation data (decoded from the base64url `opaque` auth-param). */
  opaque?: Record<string, string>;
}

/** The `stellar.charge` request payload shape. */
export interface MppChargeRequest {
  amount: string;
  currency: string;
  recipient: string;
  methodDetails?: {
    network?: string;
    feePayer?: boolean;
    maxTimeoutSeconds?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Build the `Authorization: Payment <base64url>` header value for an
 * MPP charge credential.
 */
export function encodeMppHeader(
  transactionXdr: string,
  signerPubkey: string,
  challenge: MppChallenge,
): string {
  // The `network` field comes from the server challenge. It already
  // carries the chain name (`stellar:pubnet` / `stellar:testnet`), so
  // the DID is `did:pkh:${network}:${pubkey}` — NOT `did:pkh:stellar:${network}:...`
  // (which would produce the buggy `did:pkh:stellar:stellar:pubnet:...`).
  const network = challenge.request.methodDetails?.network ?? "stellar:pubnet";
  const source = `did:pkh:${network}:${signerPubkey}`;

  // Wire shape matches mppx.Credential.serialize (see Credential.ts:131-143
  // in the mppx source): `request` is re-canonicalized + base64url'd so the
  // HMAC binding on `challenge.id` survives the round-trip; everything else
  // — including `opaque` — is spread through as a structured value. The
  // Challenge schema treats `opaque` as a `Record<string, string>`, NOT a
  // base64url string, so re-encoding it here would fail zod parsing on the
  // server with `expected 'record', received 'string'`.
  const wire = {
    challenge: {
      id: challenge.id,
      realm: challenge.realm,
      method: challenge.method,
      intent: challenge.intent,
      request: base64urlEncode(canonicalize(challenge.request)),
      ...(challenge.description !== undefined && {
        description: challenge.description,
      }),
      ...(challenge.digest !== undefined && { digest: challenge.digest }),
      ...(challenge.expires !== undefined && { expires: challenge.expires }),
      ...(challenge.opaque !== undefined && { opaque: challenge.opaque }),
    },
    payload: {
      type: "transaction" as const,
      transaction: transactionXdr,
    },
    source,
  };

  const json = JSON.stringify(wire);
  return "Payment " + base64urlEncode(json);
}

/**
 * RFC 8785 JSON Canonicalization Scheme — same behavior as
 * `ox/Json.canonicalize` which the mppx library uses.
 *
 *  - Object keys sorted recursively by UTF-16 code unit order
 *  - No whitespace
 *  - `undefined` members dropped
 *  - Primitives use ECMAScript rules (no trailing zeros, etc.)
 *
 * This implementation is limited to the JSON subset — no bigint, no
 * non-finite numbers — because MPP challenges only contain those
 * types anyway.
 */
function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Cannot canonicalize non-finite number");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (typeof value === "object") {
    const entries: string[] = [];
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      entries.push(JSON.stringify(key) + ":" + canonicalize(v));
    }
    return "{" + entries.join(",") + "}";
  }
  throw new TypeError(
    `Cannot canonicalize value of type ${typeof value}`,
  );
}

/** Base64url encode (unpadded) a UTF-8 string. */
function base64urlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
