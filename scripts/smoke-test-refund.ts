// Smoke test for parseRefundHeaders / formatRefundLines. Excluded from builds
// via the smoke-test-* prefix filter in plugin/build-lib.mjs.
import { parseRefundHeaders, formatRefundLines } from "./src/refund.js";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("  ok:", msg);
}

const ID = "6e8eb745-d90e-45fc-a258-4846e9552f16";
const URL_STATUS = `https://apiserver.mpprouter.dev/v1/refunds/${ID}`;

// 1. Full header set, as the proxy emits it on a post-payment failure.
const full = parseRefundHeaders(
  new Headers({
    "Refund-Id": ID,
    "Refund-Status": "pending",
    "Refund-Status-Url": URL_STATUS,
  }),
);
assert(full?.id === ID, "reads Refund-Id");
assert(full?.status === "pending", "reads Refund-Status");
assert(full?.statusUrl === URL_STATUS, "reads Refund-Status-Url");

// 2. Header lookup is case-insensitive (Headers normalises), and the id is
// what the payer needs — it must survive into the printed lines verbatim.
const lines = formatRefundLines(full).join("\n");
assert(lines.includes(ID), "printed output carries the refund id");
assert(lines.includes(URL_STATUS), "printed output carries the receipt URL");

// 3. Older deployments set Refund-Id with no URL (the 502 async paths).
// Rebuild the receipt URL from the request origin rather than dropping it.
const partial = parseRefundHeaders(
  new Headers({ "refund-id": ID, "refund-status": "pending" }),
  "https://apiserver.mpprouter.dev/v1/services/foo/bar",
);
assert(partial?.statusUrl === URL_STATUS, "synthesises the receipt URL from the request origin");

// 4. No origin to rebuild from → id still reported, URL omitted rather than guessed.
const noOrigin = parseRefundHeaders(new Headers({ "refund-id": ID }));
assert(noOrigin?.id === ID && noOrigin?.statusUrl === undefined, "id without URL is still reported");

// 5. Header values come from whatever endpoint was called, so a hostile
// server can put anything in them. A non-http(s) URL is dropped rather than
// echoed, and the URL is never printed as a ready-to-paste shell command.
const hostile = parseRefundHeaders(new Headers({
  "refund-id": ID,
  "refund-status-url": "javascript:alert(1)",
}));
assert(hostile?.statusUrl === undefined, "non-http(s) receipt URL is dropped");
assert(
  !formatRefundLines(full).some((l) => /curl .*https?:\/\//.test(l)),
  "the receipt URL is printed bare, never inside a runnable curl command",
);
const weirdId = parseRefundHeaders(
  new Headers({ "refund-id": "not a; uuid" }),
  "https://apiserver.mpprouter.dev/v1/services/foo/bar",
);
assert(weirdId?.statusUrl === undefined, "an implausible id is not spliced into a synthesised URL");

// 6. The ordinary case: a failure with no refund must stay silent.
assert(parseRefundHeaders(new Headers({ "content-type": "application/json" })) === null,
  "no Refund-Id → null");
assert(formatRefundLines(null).length === 0, "null refund prints nothing");

// 7. A blank header is not a refund.
assert(parseRefundHeaders(new Headers({ "refund-id": "  " })) === null,
  "blank Refund-Id is ignored");

console.log("smoke-test-refund: all assertions passed");
