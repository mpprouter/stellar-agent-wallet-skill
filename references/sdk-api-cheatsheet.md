# SDK API cheatsheet

## Constants

```typescript
// Network passphrases
Networks.TESTNET  // "Test SDF Network ; September 2015"
Networks.PUBLIC   // "Public Global Stellar Network ; September 2015"

// RPC URLs
"https://soroban-testnet.stellar.org"
"https://mainnet.sorobanrpc.com"  // or your provider

// CAIP-2
"stellar:testnet"
"stellar:pubnet"

// USDC SAC addresses
// Testnet: CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
// Pubnet:  CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75
```

## Unit conversion

```typescript
import { toBaseUnits, fromBaseUnits } from "@stellar/mpp";

toBaseUnits("1.00", 7);      // "10000000"
fromBaseUnits("10000000", 7); // "1.00"
```

USDC on Stellar: **7 decimals**. Not 6 like on EVM.

## Keypair

```typescript
import { Keypair } from "@stellar/stellar-sdk";
import { resolveKeypair } from "@stellar/mpp";

// From S... secret string
const kp = Keypair.fromSecret(process.env.STELLAR_SECRET!);

// Or: let @stellar/mpp normalize (accepts Keypair | string)
const kp2 = resolveKeypair(process.env.STELLAR_SECRET!);

// Generate new — DO NOT print the secret to stdout.
// Use scripts/generate-keypair.ts which writes to .env directly.
const newKp = Keypair.random();
console.log("Generated pubkey:", newKp.publicKey());
// newKp.secret() should be written straight to a .env file with mode 600,
// never printed or sent to any network/telemetry destination.
```

## RPC client

```typescript
import { SorobanRpc } from "@stellar/stellar-sdk";
const rpc = new SorobanRpc.Server("https://soroban-testnet.stellar.org", {
  allowHttp: false,
});

await rpc.getLatestLedger();
await rpc.getAccount(pubkey);
await rpc.simulateTransaction(tx);
```

## x402 client

```typescript
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { x402Client } from "@x402/core/client";

const signer = createEd25519Signer(secretKey, "stellar:testnet");
const client = new x402Client().register("stellar:*", new ExactStellarScheme(signer));

// Use with fetch wrapper
import { wrapFetch } from "@x402/fetch";
const paidFetch = wrapFetch(fetch, client);
const response = await paidFetch("https://some-api.example/paid-endpoint");
```

## MPP charge client

```typescript
import { stellar } from "@stellar/mpp/charge/client";
import { Mppx } from "mppx/client";

const mppx = new Mppx({
  methods: [stellar.charge({ secret: process.env.STELLAR_SECRET! })],
});

const response = await mppx.fetch("https://some-mpp-server.example/paid-endpoint");
```

## Funding testnet

Go to https://laboratory.stellar.org/#account-creator and fund the generated pubkey with Friendbot. Then swap XLM for testnet USDC via a testnet DEX or request from your server operator.

Or via CLI:

```bash
curl "https://friendbot.stellar.org?addr=$PUBKEY"
```
