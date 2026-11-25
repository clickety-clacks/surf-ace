import assert from "node:assert/strict";
import test from "node:test";

import {
  EndpointLeaseBook,
  endpointLeaseGenerationRange,
  resolveDirectEndpoint,
  validateDirectEndpoint,
} from "./endpoint-leases.ts";

test("endpoint registration generations stay stable until the registered route changes", () => {
  let now = 1000;
  const book = new EndpointLeaseBook(4, () => now);
  const first = book.observe("client-a", "ws://client-a:19001/ws|surface-a", true)!;
  now = 1500;
  const renewed = book.observe("client-a", "ws://client-a:19001/ws|surface-a", true)!;
  assert.equal(renewed.leaseGeneration, first.leaseGeneration);
  assert.equal(renewed.registrationObservedAtMs, first.registrationObservedAtMs);

  now = 1600;
  const replaced = book.observe("client-a", "ws://client-a:19002/ws|surface-a", true)!;
  assert.ok(replaced.leaseGeneration > renewed.leaseGeneration);
  assert.equal(replaced.registrationObservedAtMs, 1600);
});

test("writer restart epoch and monotonic registry time fail closed against lease reuse", () => {
  let now = 2_000_000;
  const firstWriter = new EndpointLeaseBook(7, () => now);
  const oldLease = firstWriter.observe("client-a", "route-a", true)!;
  now = 1_000;
  const restartedWriter = new EndpointLeaseBook(8, () => now);
  const newLease = restartedWriter.observe("client-a", "route-a", true)!;
  assert.ok(newLease.leaseGeneration > oldLease.leaseGeneration);
  assert.ok(newLease.registrationObservedAtMs >= 1_000);
  assert.notEqual(newLease.leaseGeneration, oldLease.leaseGeneration);
});

test("writer epoch ranges are disjoint at their boundary and reject exhausted continuity", () => {
  assert.deepEqual(endpointLeaseGenerationRange(1), { first: 1_000_001, last: 2_000_000 });
  assert.deepEqual(endpointLeaseGenerationRange(2), { first: 2_000_001, last: 3_000_000 });
  assert.equal(endpointLeaseGenerationRange(1).last + 1, endpointLeaseGenerationRange(2).first);
  const firstEpoch = new EndpointLeaseBook(1, () => 10);
  const firstGenerationInEpoch = firstEpoch.observe("client-a", "route", true)!;
  assert.equal(firstGenerationInEpoch.leaseGeneration, 1_000_001);

  const nextEpoch = new EndpointLeaseBook(2, () => 0);
  const firstGenerationInNextEpoch = nextEpoch.observe("client-b", "route", true)!;
  assert.equal(firstGenerationInNextEpoch.leaseGeneration, 2_000_001);
  assert.ok(firstGenerationInNextEpoch.leaseGeneration > firstGenerationInEpoch.leaseGeneration);

  assert.throws(
    () => endpointLeaseGenerationRange(9_007_199_254),
    /endpoint_lease_generation_exhausted/,
  );
});

test("unconfigured endpoint clears the lease and malformed URLs are rejected", () => {
  const book = new EndpointLeaseBook(2, () => 10);
  assert.equal(book.observe("client-a", "unused", false), null);
  for (const endpoint of ["http://client-a:19001/ws", "ws://user:pass@client-a/ws", "ws://client-a/ws#fragment", "not-a-url"]) {
    assert.throws(() => validateDirectEndpoint(endpoint), /invalid_direct_endpoint/);
  }
  assert.equal(validateDirectEndpoint(null), null);
  assert.equal(validateDirectEndpoint("wss://client-a.example/ws"), "wss://client-a.example/ws");
});

test("listener fallback uses the accepted peer and client source claims cannot mint registry-observed", () => {
  const listener = { scheme: "ws", port: 8080, path: "/ws" };
  assert.deepEqual(resolveDirectEndpoint(undefined, undefined, listener, "192.0.2.7"), {
    directEndpoint: "ws://192.0.2.7:8080/ws",
    directEndpointSource: "registry-observed",
  });
  assert.deepEqual(resolveDirectEndpoint(
    "wss://198.51.100.20:8080/ws",
    "client-reported",
    listener,
    "192.0.2.7",
  ), {
    directEndpoint: "wss://198.51.100.20:8080/ws",
    directEndpointSource: "client-reported",
  });
  assert.deepEqual(resolveDirectEndpoint(
    "wss://198.51.100.20:8080/ws",
    "registry-observed",
    listener,
    "192.0.2.7",
  ), {
    directEndpoint: "wss://198.51.100.20:8080/ws",
    directEndpointSource: "client-reported",
  });
  assert.deepEqual(resolveDirectEndpoint(undefined, undefined, undefined, "192.0.2.7"), {
    directEndpoint: null,
    directEndpointSource: null,
  });
  assert.deepEqual(resolveDirectEndpoint(undefined, undefined, { ...listener, port: 80 }, "192.0.2.7"), {
    directEndpoint: "ws://192.0.2.7:80/ws",
    directEndpointSource: "registry-observed",
  });
  assert.deepEqual(resolveDirectEndpoint(undefined, undefined, { ...listener, scheme: "wss", port: 443 }, "192.0.2.7"), {
    directEndpoint: "wss://192.0.2.7:443/ws",
    directEndpointSource: "registry-observed",
  });
  assert.deepEqual(resolveDirectEndpoint(undefined, undefined, listener, "2001:db8::7"), {
    directEndpoint: "ws://[2001:db8::7]:8080/ws",
    directEndpointSource: "registry-observed",
  });
  assert.throws(() => resolveDirectEndpoint(undefined, "invented", listener, "192.0.2.7"),
    /invalid_direct_endpoint_source/);
  assert.throws(() => resolveDirectEndpoint(undefined, undefined, { ...listener, port: 65_536 }, "192.0.2.7"),
    /invalid_direct_endpoint_listener/);
});
