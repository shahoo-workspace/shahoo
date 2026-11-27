import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { before } from "node:test";
import { eq } from "drizzle-orm";
import { getPglite } from "../../lib/db.ts";
import { getDb } from "../db/client.ts";
import { ensureSeed } from "../db/seed.ts";
import { auditLogs, orders, paymentAttempts, payments, paymentLogs } from "../db/schema.ts";
import { handlePayPingCallback, retryPayPingVerificationAttempt } from "./payping-lifecycle.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
let db: Awaited<ReturnType<typeof getDb>>;
let sequence = 0;

before(async () => {
  const pg = await getPglite();
  for (const name of readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(root, "migrations", name), "utf8"));
  }
  db = await getDb();
  await ensureSeed();
  process.env.NODE_ENV = "production";
  process.env.PAYMENT_PROVIDER = "payping";
  process.env.PAYPING_LIVE = "1";
  process.env.PAYPING_API_KEY = "test-key";
  process.env.PAYPING_RETURN_URL = "https://shop.example/api/payment/payping/callback";
});

async function attempt(state: "redirect_pending" | "provider_outcome_unknown", suffix: string) {
  sequence += 1;
  const orderId = `lifecycle-order-${sequence}`;
  const attemptId = `lifecycle-attempt-${sequence}`;
  const clientRefId = `11111111-1111-4111-8111-${String(sequence).padStart(12, "0")}`;
  await db.insert(orders).values({
    id: orderId, publicCode: `LC-${sequence}`, customerId: null, status: "awaiting_payment", fullName: "Lifecycle Test", mobile: "09120000000",
    province: "Test", city: "Test", addressLine: "Test", subtotalIrr: 1000, totalIrr: 1000, buyerKey: `buyer-${sequence}`,
    paymentStatus: "unpaid", stockState: "held",
  });
  await db.insert(paymentAttempts).values({
    id: attemptId, orderId, provider: "payping", amountIrr: 1000, providerAmountToman: 100, currency: "IRR", idempotencyKey: clientRefId,
    providerPaymentCode: `code-${suffix}`, providerRequestRef: clientRefId, state, expiresAt: new Date(Date.now() + 60_000),
  });
  return { attemptId, orderId, clientRefId, paymentCode: `code-${suffix}` };
}

function callback(input: { clientRefId: string; paymentCode: string; paymentRefId: number }) {
  return new Request("https://shop.example/api/payment/payping/callback", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: 1, amount: 100, ...input }),
  });
}

function providerFormCallback(input: { clientRefId: string; paymentCode: string; paymentRefId: number }) {
  return new Request("https://shop.example/api/payment/payping/callback", {
    method: "POST",
    body: new URLSearchParams({
      status: "1",
      errorCode: "",
      data: JSON.stringify({ ...input, amount: 100, gatewayAmount: 120 }),
    }),
  });
}

function failedCallback(input: { clientRefId: string; paymentCode: string; errorCode: string; amount?: number }) {
  return new Request("https://shop.example/api/payment/payping/callback", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: 0, ...input }),
  });
}

test("status=0 records an unverified failure report without terminal failure", async () => {
  const fixture = await attempt("redirect_pending", "callback-failed");
  const response = await handlePayPingCallback(failedCallback({
    clientRefId: fixture.clientRefId,
    paymentCode: fixture.paymentCode,
    errorCode: "payment_cancelled",
  }));
  assert.equal(response.status, 202);
  const [row] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
  assert.equal(row.state, "provider_outcome_unknown");
  assert.equal(row.reconciliationRequired, true);
  assert.equal(row.settlementError, "payping_callback_failure_unverified:payment_cancelled");
  const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, fixture.attemptId));
  assert.equal(audits.filter((entry) => entry.action === "payment.callback_failure_unverified").length, 1);

  const replay = await handlePayPingCallback(failedCallback({
    clientRefId: fixture.clientRefId,
    paymentCode: fixture.paymentCode,
    errorCode: "payment_cancelled",
  }));
  assert.equal(replay.status, 202);
  const replayAudits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, fixture.attemptId));
  assert.equal(replayAudits.filter((entry) => entry.action === "payment.callback_failure_unverified").length, 2);
});

test("verification 5xx becomes a persisted unknown outcome and repeated callback remains recoverable", async () => {
  const fixture = await attempt("redirect_pending", "unknown");
  const old = globalThis.fetch;
  globalThis.fetch = (async () => new Response("upstream", { status: 502 })) as typeof fetch;
  try {
    const first = await handlePayPingCallback(callback({ clientRefId: fixture.clientRefId, paymentCode: fixture.paymentCode, paymentRefId: 77 }));
    assert.equal(first.status, 202);
    const [row] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
    assert.equal(row.state, "provider_outcome_unknown");
    assert.equal(row.verificationPaymentRefId, 77);
    assert.equal(row.reconciliationRequired, true);
    const replay = await handlePayPingCallback(callback({ clientRefId: fixture.clientRefId, paymentCode: fixture.paymentCode, paymentRefId: 77 }));
    assert.equal(replay.status, 202);
  } finally { globalThis.fetch = old; }
});

test("ambiguous HTTP 400 verification response remains recoverable, not failed", async () => {
  const fixture = await attempt("redirect_pending", "rejected");
  const old = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: "rejected" }), { status: 400, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const response = await handlePayPingCallback(callback({ clientRefId: fixture.clientRefId, paymentCode: fixture.paymentCode, paymentRefId: 88 }));
    assert.equal(response.status, 202);
    const [row] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
    assert.equal(row.state, "provider_outcome_unknown");
    assert.equal(row.reconciliationRequired, true);
    assert.equal(row.verificationPaymentRefId, 88);
    assert.equal(row.providerReferenceId, null);
  } finally { globalThis.fetch = old; }
});


test("verification authorization/configuration HTTP errors do not mark a potentially paid attempt failed", async () => {
  const fixture = await attempt("redirect_pending", "auth-error");
  const old = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  try {
    const response = await handlePayPingCallback(callback({ clientRefId: fixture.clientRefId, paymentCode: fixture.paymentCode, paymentRefId: 89 }));
    assert.equal(response.status, 202);
    const [row] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
    assert.equal(row.state, "provider_outcome_unknown");
    assert.equal(row.reconciliationRequired, true);
  } finally { globalThis.fetch = old; }
});

test("verification 408 and 429 remain recoverable instead of becoming failed", async () => {
  for (const status of [408, 429]) {
    const fixture = await attempt("redirect_pending", `transient-${status}`);
    const old = globalThis.fetch;
    globalThis.fetch = (async () => new Response("temporary", { status })) as typeof fetch;
    try {
      const response = await handlePayPingCallback(callback({ clientRefId: fixture.clientRefId, paymentCode: fixture.paymentCode, paymentRefId: 100 + status }));
      assert.equal(response.status, 202);
      const [row] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
      assert.equal(row.state, "provider_outcome_unknown");
      assert.equal(row.reconciliationRequired, true);
      assert.equal(row.verificationPaymentRefId, 100 + status);
    } finally { globalThis.fetch = old; }
  }
});

test("duplicate PayPing form callbacks verify the original amount and settle one payment", { timeout: 10_000 }, async () => {
  const fixture = await attempt("redirect_pending", "duplicate-race");
  const paymentRefId = 244;
  const old = globalThis.fetch;
  const verifyRequests: unknown[] = [];
  let verificationCalls = 0;
  let releaseBoth!: () => void;
  const bothVerified = new Promise<void>((resolve) => { releaseBoth = resolve; });
  globalThis.fetch = (async (_input, init) => {
    verifyRequests.push(JSON.parse(String(init?.body)));
    verificationCalls += 1;
    if (verificationCalls === 2) releaseBoth();
    await bothVerified;
    return new Response(JSON.stringify({
      amount: 100,
      gatewayAmount: 120,
      paymentRefId,
      clientRefId: fixture.clientRefId,
      code: fixture.paymentCode,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const [first, replay] = await Promise.all([
      handlePayPingCallback(providerFormCallback({ clientRefId: fixture.clientRefId, paymentCode: fixture.paymentCode, paymentRefId })),
      handlePayPingCallback(providerFormCallback({ clientRefId: fixture.clientRefId, paymentCode: fixture.paymentCode, paymentRefId })),
    ]);
    assert.equal(verificationCalls, 2, "both concurrent callbacks reached provider verification");
    assert.deepEqual(verifyRequests, [
      { amount: 100, paymentCode: fixture.paymentCode, paymentRefId },
      { amount: 100, paymentCode: fixture.paymentCode, paymentRefId },
    ]);
    assert.equal([first.status, replay.status].every((status) => status === 200 || status === 202), true);
    assert.equal([first.status, replay.status].some((status) => status === 200), true,
      "at least one callback must complete or observe the completed settlement");

    const [attemptRow] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
    const [order] = await db.select().from(orders).where(eq(orders.id, fixture.orderId));
    const paymentRows = await db.select().from(payments).where(eq(payments.orderId, fixture.orderId));
    const paymentLogRows = paymentRows.length
      ? await db.select().from(paymentLogs).where(eq(paymentLogs.paymentId, paymentRows[0]!.id))
      : [];

    assert.equal(attemptRow.state, "settled");
    assert.equal(attemptRow.reconciliationRequired, false);
    assert.equal(attemptRow.providerReferenceId, String(paymentRefId));
    assert.equal(order.status, "paid");
    assert.equal(order.paymentStatus, "verified");
    assert.equal(paymentRows.length, 1, "duplicate callbacks must not create duplicate payments");
    assert.equal(paymentRows[0]?.status, "verified");
    assert.equal(paymentLogRows.filter((entry) => entry.event === "verified").length, 1);
  } finally {
    globalThis.fetch = old;
  }
});

test("verification retry keeps unknown state on HTTP 429", async () => {
  const fixture = await attempt("provider_outcome_unknown", "retry-429");
  await db.update(paymentAttempts).set({ verificationPaymentRefId: 129, reconciliationRequired: true }).where(eq(paymentAttempts.id, fixture.attemptId));
  const [row] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
  const old = globalThis.fetch;
  globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  try {
    await assert.rejects(() => retryPayPingVerificationAttempt(db, row), /payment_verification_outcome_unknown/);
    const [after] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
    assert.equal(after.state, "provider_outcome_unknown");
    assert.equal(after.reconciliationRequired, true);
    assert.equal(after.settlementError, "payping_verification_outcome_unknown");
  } finally { globalThis.fetch = old; }
});

test("verification retry preserves unknown state on unexpected provider transport error", async () => {
  const fixture = await attempt("provider_outcome_unknown", "retry-network");
  await db.update(paymentAttempts).set({ verificationPaymentRefId: 130, reconciliationRequired: true }).where(eq(paymentAttempts.id, fixture.attemptId));
  const [row] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
  const old = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("unexpected fetch failure"); }) as typeof fetch;
  try {
    await assert.rejects(() => retryPayPingVerificationAttempt(db, row), /payment_verification_outcome_unknown/);
    const [after] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
    assert.equal(after.state, "provider_outcome_unknown");
    assert.equal(after.reconciliationRequired, true);
  } finally { globalThis.fetch = old; }
});


test("verification retry reuses persisted identifiers and settles exactly once", async () => {
  const fixture = await attempt("provider_outcome_unknown", "retry-success");
  const paymentRefId = 177;
  await db.update(paymentAttempts).set({ verificationPaymentRefId: paymentRefId, reconciliationRequired: true }).where(eq(paymentAttempts.id, fixture.attemptId));
  const [row] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
  const old = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      amount: 100,
      paymentRefId,
      clientRefId: fixture.clientRefId,
      code: fixture.paymentCode,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await retryPayPingVerificationAttempt(db, row);
    assert.equal(result.ok, true);
    assert.equal(requestBodies[0]?.amount, 100);
    assert.equal(requestBodies[0]?.paymentCode, fixture.paymentCode);
    assert.equal(requestBodies[0]?.paymentRefId, paymentRefId);
    const [after] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
    assert.equal(after.state, "settled");
    assert.equal(after.providerReferenceId, String(paymentRefId));
    const [order] = await db.select().from(orders).where(eq(orders.id, fixture.orderId));
    assert.equal(order.paymentStatus, "verified");
    assert.equal(order.status, "paid");
  } finally { globalThis.fetch = old; }
});


test("manual-review PayPing attempts can be safely retried without creating a new attempt", async () => {
  const fixture = await attempt("provider_outcome_unknown", "manual-retry");
  const paymentRefId = 188;
  await db.update(paymentAttempts).set({ state: "manual_review", verificationPaymentRefId: paymentRefId, reconciliationRequired: true }).where(eq(paymentAttempts.id, fixture.attemptId));
  const [row] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
  const old = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ amount: 100, paymentRefId, clientRefId: fixture.clientRefId, code: fixture.paymentCode }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const result = await retryPayPingVerificationAttempt(db, row);
    assert.equal(result.ok, true);
    const [after] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, fixture.attemptId));
    assert.equal(after.state, "settled");
    assert.equal((await db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, fixture.orderId))).length, 1);
  } finally { globalThis.fetch = old; }
});
