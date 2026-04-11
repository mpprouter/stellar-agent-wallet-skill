# stellar-agent-wallet

Stellar USDC wallet for AI agents. Pay 402-gated APIs (x402 or MPP Router),
check balances, add USDC trustlines, swap XLM→USDC on the DEX, and
send/bridge USDC cross-chain to EVM, Solana, or back to Stellar via Rozo.
File-based secret storage, sponsored mode, testnet and mainnet.

## Install (Claude Code plugin)

```
/plugin marketplace add mpprouter/stellar-agent-wallet-skill
/plugin install stellar-agent-wallet@mpprouter
```

## Security

This skill is a **wallet**. It signs Stellar transactions with a private
key stored at `.stellar-secret` (mode 600, created by
`scripts/generate-keypair.ts`). Use a dedicated hot wallet — never your
main account. Default network is `pubnet` (mainnet); pass
`--network testnet` while prototyping.

See `SKILL.md` for the full security banner and `references/mainnet-checklist.md`
before pointing this at real money.

## Development

```bash
npm run build:skill     # build/skill/ — upload manually to skill marketplace
npm run build:plugin    # build/plugin/ + .claude-plugin/marketplace.json
npm run build:all
```

Source of truth: `version.json`. Bump the version there, run `build:all`,
commit, tag, push.

## License

MIT
