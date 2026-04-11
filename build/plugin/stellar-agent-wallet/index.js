// stellar-agent-wallet plugin entry.
//
// This plugin is skill-based: its runtime is the Node/tsx scripts in
// skills/*/run.ts and scripts/src/*.ts that the agent invokes by
// following the SKILL.md files in skills/. There is no OpenClaw SDK
// registration here because the plugin does not expose an LLM
// provider, channel, memory backend, or context engine.
//
// OpenClaw loads this file at plugin discovery time via the
// openclaw.extensions array in package.json. We hand-roll a
// PluginEntry-shaped object instead of importing definePluginEntry
// from 'openclaw/plugin-sdk/plugin-entry' so the plugin has no
// runtime dependency on the openclaw package — it must load cleanly
// in any Claude Code installation, with or without openclaw present.
//
// Shape reference: openclaw/openclaw src/plugin-sdk/plugin-entry.ts,
// function definePluginEntry (returns {id, name, description,
// configSchema getter, register}).

const emptyConfigSchema = {
  type: "object",
  additionalProperties: false,
};

export default {
  id: "stellar-agent-wallet",
  name: "Stellar Agent Wallet",
  description: "Stellar USDC wallet for AI agents. Pay 402-gated APIs (x402 or MPP Router), check balances, add USDC trustlines, swap XLM→USDC on the DEX, and send/bridge USDC cross-chain to EVM, Solana, or back to Stellar via Rozo. File-based secret storage, sponsored mode, testnet and mainnet.",
  get configSchema() {
    return emptyConfigSchema;
  },
  register() {
    // Intentionally empty. This plugin ships skills and runtime scripts,
    // not SDK-registered capabilities. All user-facing functionality
    // lives in SKILL.md files and the .ts runtime.
  },
};
