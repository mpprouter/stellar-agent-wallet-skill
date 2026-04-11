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

## Flow

1. First attempt: plain POST/GET to the URL.
2. Expect `402 Payment Required`. Parse the challenge:
   - **x402 format** — response body is `{ x402Version, accepts: [PaymentRequirements] }`.
   - **MPP Router format** — `WWW-Authenticate: Payment request=<base64-json>` header with `{ amount, currency, recipient, methodDetails }`.
3. Both formats produce the same inner XDR (sponsored SAC transfer). We sign once.
4. Wrap the XDR in the envelope matching the challenge:
   - x402 → base64 JSON in `X-Payment` header
   - MPP → `Authorization: Payment <credential>` header
5. Re-POST/GET with the payment header attached.
6. Return the response body + any `Payment-Receipt` header for auditing.

## How to run

```bash
# MPP Router service (discovered via discover skill)
npx tsx commands/pay-per-call/run.ts \
  "https://apiserver.mpprouter.dev/v1/services/parallel/search" \
  --body '{"query": "Summarize https://stripe.com/docs"}' \
  --method POST

# x402 facilitator
npx tsx commands/pay-per-call/run.ts https://some-x402-api.example/endpoint

# Include JSON output mode
npx tsx commands/pay-per-call/run.ts <url> --body '{...}' --json

# Save payment receipt to file
npx tsx commands/pay-per-call/run.ts <url> --receipt-out receipt.json
```

## Safety

- ✅ **Credentials are single-use** — if the first retry fails, the credential is burned. Don't blindly re-retry; start fresh.
- ✅ **Confirmation on mainnet above threshold** — by default, pubnet calls above $0.10 prompt for confirmation. Override with `--yes` or `--max-auto <usd>`.
- ✅ **Amount validation** — script verifies the 402 challenge amount matches the advertised service price (if known from catalog).
- ❌ **Don't reuse a credential** — the HMAC binding to amount/currency/recipient is the router's defense against replay.

## Example: full MPP Router flow

```bash
# Discover
SERVICE=$(npx tsx commands/discover/run.ts --query "web search" --pick-one --json)
URL="https://apiserver.mpprouter.dev$(echo "$SERVICE" | jq -r '.public_path')"

# Call
npx tsx commands/pay-per-call/run.ts "$URL" \
  --body '{"query": "Summarize https://stripe.com/docs"}' \
  --method POST
```

## Env vars used

- `STELLAR_SECRET`, `STELLAR_NETWORK`, `STELLAR_RPC_URL` — for signing
- `STELLAR_ASSET_SAC` — default asset if challenge doesn't specify one
