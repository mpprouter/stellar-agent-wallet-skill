/**
 * Secret handling — file-based loader with guardrails.
 *
 * Rules enforced here:
 *   1. Secrets come from a file path. No environment reads.
 *   2. The file contents must match the Stellar strkey pattern (S... 56 chars).
 *   3. We install a stdout/stderr wrapper that replaces any accidental
 *      occurrence of the secret with [REDACTED].
 *   4. No module-level storage — loadSecretFromFile returns the value and
 *      the caller holds it in a local binding only.
 */

import * as fs from "node:fs";

const REDACTED = "[REDACTED:signing-key]";

/**
 * Read a Stellar secret key from a file path.
 *
 * The file should contain a single line: the S... strkey. Any surrounding
 * whitespace is trimmed. Blank lines and lines starting with # are ignored
 * so the same file can carry a comment header if desired.
 */
export function loadSecretFromFile(path: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error(
        `Secret file not found at ${path}. Generate one with:\n` +
          `  npx tsx scripts/generate-keypair.ts\n` +
          `or pass an existing file via --secret-file <path>.`,
      );
    }
    throw err;
  }

  // Pick the first non-blank, non-comment line.
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));

  if (!line) {
    throw new Error(
      `Secret file ${path} is empty or only contains comments.`,
    );
  }

  if (!/^S[A-Z0-9]{55}$/.test(line)) {
    throw new Error(
      `Secret file ${path} does not contain a valid Stellar secret key ` +
        `(expected 56 characters starting with S).`,
    );
  }

  installRedactor(line);
  return line;
}

/**
 * Wrap process.stdout.write and process.stderr.write so that any
 * accidental occurrence of the secret is replaced with [REDACTED].
 *
 * This is a belt-and-braces defense — code should never pass the
 * secret to a print function in the first place.
 */
function installRedactor(secret: string): void {
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
