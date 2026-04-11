/**
 * Secret handling — central guardrails for STELLAR_SECRET.
 *
 * Rules enforced here:
 *   1. Secret is read from process.env.STELLAR_SECRET ONCE at a known entry
 *      point, and passed downstream as a function argument.
 *   2. Secret must NOT appear in process.argv (users who pass it on the
 *      command line by mistake get a hard error).
 *   3. Secret is never written to stdout/stderr. We install a wrapper on
 *      process.stdout.write and process.stderr.write that redacts any
 *      occurrence of the secret.
 *   4. No module-level storage — the secret is returned from loadSecret()
 *      and the caller holds it in a local binding, not a global.
 *
 * Keep this file free of `fetch` calls and unrelated concerns.
 */

const REDACTED = "[REDACTED:STELLAR_SECRET]";

/**
 * Read STELLAR_SECRET from the environment, enforce guards, and return it.
 *
 * Callers should hold the returned value in a local variable and pass it
 * directly to signer functions. Do not store it in a module-level binding.
 */
export function loadSecret(): string {
  const argv = process.argv.slice(2).join(" ");
  if (/\bS[A-Z0-9]{55}\b/.test(argv)) {
    // Looks like a raw Stellar secret was passed on the command line.
    throw new Error(
      "Refusing to run: a Stellar secret appears to be on the command line. " +
        "Never pass STELLAR_SECRET as an argument — put it in a .env file instead.",
    );
  }

  const secret = process.env.STELLAR_SECRET;
  if (!secret) {
    throw new Error(
      "STELLAR_SECRET is required. Create a .env file with STELLAR_SECRET=S...",
    );
  }
  if (!/^S[A-Z0-9]{55}$/.test(secret)) {
    throw new Error(
      "STELLAR_SECRET in .env does not look like a Stellar secret key (S... 56 chars).",
    );
  }

  installStdoutRedactor(secret);
  return secret;
}

/**
 * Wrap process.stdout.write and process.stderr.write so that any
 * accidental occurrence of the secret is replaced with [REDACTED].
 *
 * This is a belt-and-braces defense — the code should never pass the
 * secret to a print function in the first place.
 */
function installStdoutRedactor(secret: string): void {
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  const redact = (chunk: any): any => {
    if (typeof chunk === "string") {
      return chunk.includes(secret) ? chunk.split(secret).join(REDACTED) : chunk;
    }
    if (Buffer.isBuffer(chunk)) {
      const s = chunk.toString("utf8");
      if (s.includes(secret)) {
        return Buffer.from(s.split(secret).join(REDACTED), "utf8");
      }
    }
    return chunk;
  };

  process.stdout.write = ((chunk: any, ...rest: any[]) =>
    origStdout(redact(chunk), ...rest)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any, ...rest: any[]) =>
    origStderr(redact(chunk), ...rest)) as typeof process.stderr.write;
}

/**
 * Utility for commands that don't need to sign — derives the public
 * key of the configured secret without holding onto it.
 */
export function pubkeyOnly(): string {
  const secret = loadSecret();
  // Import dynamically so callers that never need this function don't
  // pay the stellar-sdk load cost.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Keypair } = require("@stellar/stellar-sdk");
  const pk = Keypair.fromSecret(secret).publicKey();
  // `secret` goes out of scope here.
  return pk;
}
