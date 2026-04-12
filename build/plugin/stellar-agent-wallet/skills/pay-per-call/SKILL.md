---
name: pay-per-call
description: Call a 402-gated HTTP API and pay automatically with Stellar USDC. Handles the 402 → sign → retry loop for both MPP Router services and x402 facilitators. Triggers on "call this paid API", "pay and fetch <url>", "summarize via parallel.ai", or after `discover-mpprouter` picks a service. Reads 402 challenges in either x402 format (X-Payment header) or MPP format (mppx Credential) and signs with the same underlying Stellar key.
---

# pay-per-call

The "execute" step of the wallet agent. Call a paid HTTP endpoint, handle the 402 response, sign, retry, return the result.

## When to trigger

- After `discover-mpprouter` returns a service to call
- "Call <url> and pay with stellar"
- "Fetch this paid endpoint"
- "Summarize https://stripe.com/docs using parallel.ai via mpprouter" (chain: discover → pay-per-call)

## Not for

- Unpaid HTTP calls — just use `fetch`
- Cross-chain payments — use `send-payment` or `bridge`
- Pure SDK-level signing without HTTP — use the `client.ts` template directly

## Prerequisites

Before calling a service, you need to know its request body format.
The MPP Router **forwards request bodies as-is** — it does not
transform or validate them.

- **If you already know the schema** (e.g. from the user's prompt or
  prior context) → proceed directly.
- **If you don't** → run `discover` first. The service's `docs` field
  points to upstream API documentation. Read `docs.llms_txt` (preferred)
  or `docs.api_reference` to learn the correct request shape before
  paying. Sending a malformed body wastes the payment.

## Flow

1. First attempt: plain POST/GET to the URL.
2. Expect `402 Payment Required`. Parse the challenge in this priority order:
   1. **MPP dialect** — `WWW-Authenticate: Payment request="<base64>"` header.
      Values may be quoted or unquoted per RFC 7235; we accept both.
   2. **x402 v2 dialect** — `Payment-Required: <base64>` response header
      carrying `{ x402Version, accepts: [PaymentRequirements] }`.
   3. **x402 legacy** — same envelope but in the JSON response body
      (older x402 servers).
3. Both formats produce the same inner XDR (sponsored SAC transfer). We sign once.
4. Wrap the XDR in the envelope matching the challenge:
   - x402 → base64 JSON in `X-Payment` header
   - MPP → `Authorization: Payment <credential>` header
5. Re-POST/GET with the payment header attached.
6. Return the response body + any `Payment-Receipt` header for auditing.

### Dialect priority — when a server emits multiple

MPP Router is the canonical example: a single 402 response includes
BOTH the MPP `WWW-Authenticate` header AND the x402 `Payment-Required`
header, with **different `payTo` addresses** for each dialect. The
addresses are HMAC-bound to the challenge, so you can't mix them —
pay the MPP address with an MPP credential, or the x402 address with
an x402 envelope. Pay the wrong address and the server rejects the
request while you still eat the on-chain fee.

This skill always tries MPP first and uses the MPP address if that
header is present. The x402 `Payment-Required` header is only used
when the MPP header is absent. If you need to force the x402 path
for a server that emits both, use a different client — this skill
doesn't expose a dialect override.

## How to run

```bash
# MPP Router service (discovered via discover skill)
npx tsx skills/pay-per-call/run.ts \
  "https://apiserver.mpprouter.dev/v1/services/parallel/search" \
  --body '{"query": "Summarize https://stripe.com/docs"}' \
  --method POST

# x402 facilitator
npx tsx skills/pay-per-call/run.ts https://some-x402-api.example/endpoint

# Include JSON output mode
npx tsx skills/pay-per-call/run.ts <url> --body '{...}' --json

# Save payment receipt to file
npx tsx skills/pay-per-call/run.ts <url> --receipt-out receipt.json
```

## Safety

- ✅ **Credentials are single-use** — if the first retry fails, the credential is burned. Don't blindly re-retry; start fresh.
- ✅ **Mainnet payments above $0.10 require confirmation** — micropayments up to $0.10 are auto-approved (covers typical MPP Router API calls at $0.001–$0.01). Override with `--max-auto <usd>` or `--yes`.
- ✅ **Amount validation** — script verifies the 402 challenge amount matches the advertised service price (if known from catalog).
- ❌ **Don't reuse a credential** — the HMAC binding to amount/currency/recipient is the router's defense against replay.

## Example: full MPP Router flow

```bash
# Discover
SERVICE=$(npx tsx skills/discover/run.ts --query "web search" --pick-one --json)
URL="https://apiserver.mpprouter.dev$(echo "$SERVICE" | jq -r '.public_path')"

# Call
npx tsx skills/pay-per-call/run.ts "$URL" \
  --body '{"query": "Summarize https://stripe.com/docs"}' \
  --method POST
```

## Env vars used

- `--secret-file`, `--network`, `--rpc-url` — for signing
- `--asset-sac <address>` — default asset if challenge doesn't specify one
