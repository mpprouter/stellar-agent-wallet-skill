/**
 * Refund-header decoding — pure library.
 *
 * When a paid call fails *after* the payment settled, the MPP Router
 * refunds automatically and reports the refund only in response headers:
 *
 *   Refund-Id:         <uuid>
 *   Refund-Status:     pending | manual-review
 *   Refund-Status-Url: https://<router>/v1/refunds/<uuid>
 *
 * Nothing in the response body carries the refund id, so a client that
 * prints only the body leaves the payer with no way to fetch the signed
 * receipt at `GET /v1/refunds/{id}`. Decoding is best-effort: a response
 * without the headers yields `null` rather than an error.
 */

export interface RefundInfo {
  /** Public refund id — the `{refund_id}` in `GET /v1/refunds/{refund_id}`. */
  id: string;
  /** Router-reported state, e.g. `pending` or `manual-review`. */
  status?: string;
  /** Absolute receipt URL, synthesised from the id when the header is absent. */
  statusUrl?: string;
}

function header(headers: Headers, name: string): string | undefined {
  const v = headers.get(name);
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Read the refund headers off a response. Returns `null` when the router
 * did not refund this call (the common case: an error before payment).
 */
export function parseRefundHeaders(
  headers: Headers,
  requestUrl?: string,
): RefundInfo | null {
  const id = header(headers, "refund-id");
  if (!id) return null;

  let statusUrl = header(headers, "refund-status-url");
  // Older router deployments set `Refund-Id` without the URL (see the 502
  // async-delivery paths). Rebuild it from the request origin so the payer
  // still gets a link to fetch the receipt from.
  if (!statusUrl && requestUrl) {
    try {
      statusUrl = `${new URL(requestUrl).origin}/v1/refunds/${id}`;
    } catch {
      statusUrl = undefined;
    }
  }

  return { id, status: header(headers, "refund-status"), statusUrl };
}

/**
 * Human-readable lines for a refund, in the same stderr style as the
 * payment summary. Returns an empty array when there is no refund.
 */
export function formatRefundLines(info: RefundInfo | null): string[] {
  if (!info) return [];
  const lines = [
    `💸 Payment refunded automatically (the call was paid but not fulfilled)`,
    `   Refund-Id:     ${info.id}`,
  ];
  if (info.status) lines.push(`   Refund-Status: ${info.status}`);
  if (info.statusUrl) {
    lines.push(`   Receipt:       curl -s ${info.statusUrl}`);
    lines.push(
      `   Poll until "outcome" leaves "refund_pending" (usually ~25s), then`,
    );
    lines.push(
      `   verify the Ed25519 signature: see references/verifying-refunds.md`,
    );
  }
  return lines;
}
