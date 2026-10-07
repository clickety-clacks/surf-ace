import assert from "node:assert/strict";
import test from "node:test";

import { custodyUncertaintyDiagnostic, PersistenceOutcomeUnknownError } from "./custody.js";

test("custody uncertainty retains stage and safe cause category without exposing cause text", () => {
  const cause = Object.assign(new Error("postgresql://writer:secret@db/fleet disconnected"), {
    code: "ECONNRESET",
  });
  const error = new PersistenceOutcomeUnknownError("claim_pane", cause, "post_commit_verification");
  const diagnostic = custodyUncertaintyDiagnostic(error);

  assert.equal(error.message, "claim_pane durability is unknown; query custody by idempotency identity");
  assert.equal(diagnostic.operation, "claim_pane");
  assert.equal(diagnostic.stage, "post_commit_verification");
  assert.equal(diagnostic.causeName, "Error");
  assert.equal(diagnostic.causeCode, "ECONNRESET");
  assert.match(diagnostic.causeMessageSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|writer:|postgresql:\/\//);
});

test("custody uncertainty refuses unbounded or unsafe cause tokens", () => {
  const error = new PersistenceOutcomeUnknownError("claim_pane", {
    code: "unsafe value with spaces",
    message: "sensitive detail",
    name: "\nforged-log-line",
  });
  const diagnostic = custodyUncertaintyDiagnostic(error);

  assert.equal(diagnostic.stage, "reconciliation");
  assert.equal(diagnostic.causeCode, null);
  assert.equal(diagnostic.causeName, "unknown");
  assert.doesNotMatch(JSON.stringify(diagnostic), /sensitive detail|forged-log-line/);
});

test("custody uncertainty retains a PostgreSQL SQLSTATE on a commit failure", () => {
  const error = new PersistenceOutcomeUnknownError("claim_pane", {
    code: "40001",
    message: "postgresql://writer:secret@db/fleet serialization failure",
    name: "error",
  }, "commit_ack");
  const diagnostic = custodyUncertaintyDiagnostic(error);

  assert.equal(diagnostic.operation, "claim_pane");
  assert.equal(diagnostic.stage, "commit_ack");
  assert.equal(diagnostic.causeName, "error");
  assert.equal(diagnostic.causeCode, "40001");
  assert.match(diagnostic.causeMessageSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|postgresql:\/\//);
});
