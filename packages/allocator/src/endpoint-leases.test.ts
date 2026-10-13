import assert from "node:assert/strict";
import test from "node:test";

import { EndpointLeaseBook, endpointLeaseGenerationRange, validateDirectEndpoint } from "./endpoint-leases.ts";

test("endpoint leases renew in place and advance when the registered route changes", () => {
  let now = 1000;
  const book = new EndpointLeaseBook(4, 5000, () => now);
  const first = book.renew("client-a", "ws://client-a:19001/ws|surface-a", true)!;
  now = 1500;
  const renewed = book.renew("client-a", "ws://client-a:19001/ws|surface-a", true)!;
  assert.equal(renewed.leaseGeneration, first.leaseGeneration);
  assert.equal(renewed.registrationObservedAtMs, first.registrationObservedAtMs);
  assert.equal(renewed.leaseExpiresAtMs, 6500);

  now = 1600;
  const replaced = book.renew("client-a", "ws://client-a:19002/ws|surface-a", true)!;
  assert.ok(replaced.leaseGeneration > renewed.leaseGeneration);
  assert.equal(replaced.registrationObservedAtMs, 1600);
  assert.equal(replaced.leaseExpiresAtMs, 6600);
});

test("writer restart epoch and monotonic registry time fail closed against lease reuse", () => {
  let now = 2_000_000;
  const firstWriter = new EndpointLeaseBook(7, 1000, () => now);
  const oldLease = firstWriter.renew("client-a", "route-a", true)!;
  now = 1_000;
  const restartedWriter = new EndpointLeaseBook(8, 1000, () => now);
  const newLease = restartedWriter.renew("client-a", "route-a", true)!;
  assert.ok(newLease.leaseGeneration > oldLease.leaseGeneration);
  assert.ok(newLease.registrationObservedAtMs >= 1_000);
  assert.notEqual(newLease.leaseGeneration, oldLease.leaseGeneration);
});

test("writer epoch ranges are disjoint at their boundary and reject exhausted continuity", () => {
  assert.deepEqual(endpointLeaseGenerationRange(1), { first: 1_000_001, last: 2_000_000 });
  assert.deepEqual(endpointLeaseGenerationRange(2), { first: 2_000_001, last: 3_000_000 });
  assert.equal(endpointLeaseGenerationRange(1).last + 1, endpointLeaseGenerationRange(2).first);
  const firstEpoch = new EndpointLeaseBook(1, 1000, () => 10);
  const firstGenerationInEpoch = firstEpoch.renew("client-a", "route", true)!;
  assert.equal(firstGenerationInEpoch.leaseGeneration, 1_000_001);

  const nextEpoch = new EndpointLeaseBook(2, 1000, () => 0);
  const firstGenerationInNextEpoch = nextEpoch.renew("client-b", "route", true)!;
  assert.equal(firstGenerationInNextEpoch.leaseGeneration, 2_000_001);
  assert.ok(firstGenerationInNextEpoch.leaseGeneration > firstGenerationInEpoch.leaseGeneration);

  assert.throws(
    () => endpointLeaseGenerationRange(9_007_199_254),
    /endpoint_lease_generation_exhausted/,
  );
});

test("unconfigured endpoint clears the lease and malformed URLs are rejected", () => {
  const book = new EndpointLeaseBook(2, 1000, () => 10);
  assert.equal(book.renew("client-a", "unused", false), null);
  for (const endpoint of ["http://client-a:19001/ws", "ws://user:pass@client-a/ws", "ws://client-a/ws#fragment", "not-a-url"]) {
    assert.throws(() => validateDirectEndpoint(endpoint), /invalid_direct_endpoint/);
  }
  assert.equal(validateDirectEndpoint(null), null);
  assert.equal(validateDirectEndpoint("wss://client-a.example/ws"), "wss://client-a.example/ws");
});
