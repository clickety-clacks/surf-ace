import assert from "node:assert/strict";
import test from "node:test";

type PaneIdentity = {
  fleetId: string;
  allocatorId: string;
  clientId: string;
  surfaceId: string;
  paneId: string;
  paneLineageId: string;
};
type PaneStatus = "active" | "recoverable" | "terminal-retired" | "released" | "offline" | "saved" | "unknown" | "legacy";
type PaneRecord = PaneIdentity & {
  paneLabel: number;
  allocationGeneration: number | null;
  status: PaneStatus;
  tombstoneId: string | null;
  closeRevision: number | null;
  terminalRetirementRevision: number | null;
  pendingRelease: boolean;
};
type AllocationView = PaneIdentity & {
  paneLabel: number;
  allocationGeneration: number | null;
  status: PaneStatus;
};
type ReleaseEvidence = PaneIdentity & {
  paneLabel: number;
  allocationGeneration: number | null;
  tombstoneId: string | null;
  closeRevision: number | null;
  terminalRetirementRevision: number | null;
  idempotencyKey: string;
};
type GateName = "allocator" | "clients" | "backupReaders" | "referenceResolvers" | "rollbackReaders";
type ModelOptions = {
  journalComplete?: boolean;
  reuseRequested?: boolean;
  gates?: Partial<Record<GateName, boolean>>;
};

// Reference model for DESIGN §3.1.1.1 only. This does not exercise the
// allocator implementation, SQL, client persistence, or any live registry.
const identity = (paneId: string, lineageId = `lineage-${paneId}`, clientId = "client-a", surfaceId = "surface-a"): PaneIdentity => ({
  fleetId: "fleet-a",
  allocatorId: "allocator-a",
  clientId,
  surfaceId,
  paneId,
  paneLineageId: lineageId,
});

const identityKey = (value: PaneIdentity): string => [
  value.fleetId,
  value.allocatorId,
  value.clientId,
  value.surfaceId,
  value.paneId,
  value.paneLineageId,
].join("/");

const stableIdentity = (value: PaneIdentity): PaneIdentity => ({
  fleetId: value.fleetId,
  allocatorId: value.allocatorId,
  clientId: value.clientId,
  surfaceId: value.surfaceId,
  paneId: value.paneId,
  paneLineageId: value.paneLineageId,
});

class PaneLabelReuseModel {
  journalComplete: boolean;
  reuseEnabled: boolean;
  nextPaneLabelFence: number;
  allocationGenerationFence: number;
  byIdentity: Map<string, PaneRecord>;
  byLabel: Map<number, PaneRecord[]>;

  constructor({
    journalComplete = true,
    reuseRequested = true,
    gates = {
      allocator: true,
      clients: true,
      backupReaders: true,
      referenceResolvers: true,
      rollbackReaders: true,
    },
  }: ModelOptions = {}) {
    this.journalComplete = journalComplete;
    const gateState: Record<GateName, boolean> = {
      allocator: true,
      clients: true,
      backupReaders: true,
      referenceResolvers: true,
      rollbackReaders: true,
      ...gates,
    };
    const requiredGates: GateName[] = [
      "allocator",
      "clients",
      "backupReaders",
      "referenceResolvers",
      "rollbackReaders",
    ];
    this.reuseEnabled = reuseRequested && requiredGates.every((name) => gateState[name]);
    this.nextPaneLabelFence = 1;
    this.allocationGenerationFence = 0;
    this.byIdentity = new Map();
    this.byLabel = new Map();
  }

  recordsForLabel(label: number): PaneRecord[] {
    return this.byLabel.get(label) ?? [];
  }

  recordFor(identityValue: PaneIdentity): PaneRecord | undefined {
    return this.byIdentity.get(identityKey(identityValue));
  }

  reserveExisting(label: number, identityValue: PaneIdentity, status: PaneStatus = "active"): PaneRecord {
    assert.ok(Number.isSafeInteger(label) && label > 0);
    assert.equal(this.recordFor(identityValue), undefined);
    const record = {
      ...identityValue,
      paneLabel: label,
      allocationGeneration: null,
      status,
      tombstoneId: null,
      closeRevision: null,
      terminalRetirementRevision: null,
      pendingRelease: false,
    };
    this.addRecord(record);
    this.nextPaneLabelFence = Math.max(this.nextPaneLabelFence, label + 1);
    return record;
  }

  addRecord(record: PaneRecord): void {
    this.byIdentity.set(identityKey(record), record);
    const history = this.recordsForLabel(record.paneLabel);
    history.push(record);
    this.byLabel.set(record.paneLabel, history);
  }

  chooseLabel(): number {
    if (!this.reuseEnabled || !this.journalComplete) {
      let label = this.nextPaneLabelFence;
      while (this.recordsForLabel(label).some((record) => record.status !== "released")) label += 1;
      return label;
    }
    let label = 1;
    while (this.recordsForLabel(label).some((record) => record.status !== "released")) label += 1;
    return label;
  }

  allocate(identityValue: PaneIdentity): AllocationView {
    const previous = this.recordFor(identityValue);
    if (previous) {
      if (previous.status === "released" || previous.status === "terminal-retired") {
        throw new Error("terminally retired pane identity cannot be claimed");
      }
      if (previous.allocationGeneration === null) {
        throw new Error("legacy claim requires owner-verified migration");
      }
      return this.view(previous);
    }
    const paneLabel = this.chooseLabel();
    this.allocationGenerationFence += 1;
    const record = {
      ...identityValue,
      paneLabel,
      allocationGeneration: this.allocationGenerationFence,
      status: "active",
      tombstoneId: null,
      closeRevision: null,
      terminalRetirementRevision: null,
      pendingRelease: false,
    };
    this.addRecord(record);
    this.nextPaneLabelFence = Math.max(this.nextPaneLabelFence, paneLabel + 1);
    return this.view(record);
  }

  close(identityValue: PaneIdentity, tombstoneId: string, closeRevision: number): AllocationView {
    const record = this.recordFor(identityValue);
    assert.ok(record && record.status === "active");
    record.status = "recoverable";
    record.tombstoneId = tombstoneId;
    record.closeRevision = closeRevision;
    return this.view(record);
  }

  disconnect(identityValue: PaneIdentity): AllocationView {
    const record = this.recordFor(identityValue);
    assert.ok(record && ["active", "recoverable"].includes(record.status));
    return this.view(record);
  }

  restore(identityValue: PaneIdentity): AllocationView {
    const record = this.recordFor(identityValue);
    if (!record || record.status !== "recoverable") throw new Error("pane is not restorable");
    record.status = "active";
    return this.view(record);
  }

  retire(identityValue: PaneIdentity, retirementRevision: number, durable = true): AllocationView {
    const record = this.recordFor(identityValue);
    assert.ok(record && record.status === "recoverable");
    if (!durable) throw new Error("terminal retirement is not durable");
    record.status = "terminal-retired";
    record.terminalRetirementRevision = retirementRevision;
    return this.view(record);
  }

  releaseEvidence(record: PaneRecord): ReleaseEvidence {
    if (record.allocationGeneration === null) throw new Error("legacy allocation has no generation");
    return {
      ...stableIdentity(record),
      paneLabel: record.paneLabel,
      allocationGeneration: record.allocationGeneration,
      tombstoneId: record.tombstoneId,
      closeRevision: record.closeRevision,
      terminalRetirementRevision: record.terminalRetirementRevision,
      idempotencyKey: `release:${identityKey(record)}:${record.allocationGeneration}`,
    };
  }

  release(identityValue: PaneIdentity, evidence: ReleaseEvidence, persistence: "committed" | "unknown" = "committed"): boolean {
    const record = this.recordFor(identityValue);
    if (!record) throw new Error("unknown allocation");
    if (record.status === "released") {
      assert.deepEqual(evidence, this.releaseEvidence(record));
      return true;
    }
    if (record.status !== "terminal-retired") throw new Error("client terminal retirement is required");
    assert.deepEqual(evidence, this.releaseEvidence(record));
    if (persistence === "unknown") {
      record.pendingRelease = true;
      return false;
    }
    if (persistence !== "committed") throw new Error("release is not durably committed");
    record.status = "released";
    record.pendingRelease = false;
    return true;
  }

  readbackRelease(identityValue: PaneIdentity, evidence: ReleaseEvidence, committed: boolean): boolean {
    const record = this.recordFor(identityValue);
    assert.ok(record && record.status === "terminal-retired" && record.pendingRelease);
    assert.deepEqual(evidence, this.releaseEvidence(record));
    if (committed) record.status = "released";
    record.pendingRelease = false;
    return committed;
  }

  resolveStableReference(identityValue: PaneIdentity, allocationGeneration: number): PaneRecord | null {
    const current = this.recordsForIdentity(identityValue);
    if (!current) return null;
    return this.recordsForLabel(current.paneLabel)
      .find((record) => identityKey(record) === identityKey(identityValue)
        && record.allocationGeneration === allocationGeneration) ?? null;
  }

  recordsForIdentity(identityValue: PaneIdentity): PaneRecord | null {
    return this.recordFor(identityValue) ?? null;
  }

  resolveHistoricalNumberOnly(label: number): { status: "ambiguous" | "single-generation" | "missing" } {
    const generations = this.recordsForLabel(label).map((record) => record.allocationGeneration);
    if (new Set(generations).size > 1) return { status: "ambiguous" };
    return { status: this.recordsForLabel(label).length ? "single-generation" : "missing" };
  }

  restoreBackup(snapshot: AllocationView): { status: "history-only"; paneLabel: null } | { status: "live"; paneLabel: number; allocationGeneration: number } {
    const records = this.recordsForLabel(snapshot.paneLabel);
    const exact = records.find((record) => identityKey(record) === identityKey(snapshot)
      && record.allocationGeneration === snapshot.allocationGeneration);
    if (!exact || exact.status === "released" || exact.status === "terminal-retired") {
      return { status: "history-only", paneLabel: null };
    }
    return { status: "live", paneLabel: exact.paneLabel, allocationGeneration: exact.allocationGeneration };
  }

  view(record: PaneRecord): AllocationView {
    return {
      ...stableIdentity(record),
      paneLabel: record.paneLabel,
      allocationGeneration: record.allocationGeneration,
      status: record.status,
    };
  }
}

function closeAndRetire(model: PaneLabelReuseModel, pane: AllocationView, closeRevision = 4): ReleaseEvidence {
  model.close(pane, `tombstone-${pane.paneId}`, closeRevision);
  model.retire(pane, closeRevision + 1, true);
  const record = model.recordFor(pane);
  assert.ok(record);
  return model.releaseEvidence(record);
}

test("the lowest positive safely available number is used only for a new pane; existing labels do not move", () => {
  const model = new PaneLabelReuseModel();
  const existing = model.allocate(identity("pane-1"));
  const releasedPane = model.allocate(identity("pane-2"));
  const untouched = model.allocate(identity("pane-3"));
  const release = closeAndRetire(model, releasedPane);
  assert.equal(model.release(releasedPane, release), true);

  const newPane = model.allocate(identity("pane-4"));
  assert.equal(existing.paneLabel, 1);
  assert.equal(untouched.paneLabel, 3);
  assert.equal(model.recordFor(identity("pane-3"))?.paneLabel, 3);
  assert.equal(newPane.paneLabel, 2);
  assert.ok(newPane.allocationGeneration > releasedPane.allocationGeneration);
});

test("a recoverable close, disconnect, or ordinary restore keeps the same label and generation reserved", () => {
  const model = new PaneLabelReuseModel();
  const pane = model.allocate(identity("pane-1"));
  assert.deepEqual(model.disconnect(identity("pane-1")), pane);
  assert.equal(model.allocate(identity("pane-2")).paneLabel, 2);
  model.close(identity("pane-1"), "tombstone-pane-1", 10);
  assert.throws(() => model.retire(identity("pane-1"), 11, false), /not durable/);
  assert.throws(() => model.release(identity("pane-1"), {} as ReleaseEvidence), /terminal retirement/);
  const restored = model.restore(identity("pane-1"));
  assert.equal(restored.paneLabel, pane.paneLabel);
  assert.equal(restored.allocationGeneration, pane.allocationGeneration);
});

test("release is fenced by exact identity, generation, tombstone, close revision, and terminal-retirement revision", () => {
  const model = new PaneLabelReuseModel();
  const pane = model.allocate(identity("pane-1"));
  const evidence = closeAndRetire(model, pane, 17);
  for (const changed of [
    { ...evidence, clientId: "client-b" },
    { ...evidence, allocationGeneration: evidence.allocationGeneration + 1 },
    { ...evidence, tombstoneId: "another-tombstone" },
    { ...evidence, closeRevision: evidence.closeRevision + 1 },
    { ...evidence, terminalRetirementRevision: evidence.terminalRetirementRevision + 1 },
  ]) {
    assert.throws(() => model.release(pane, changed), /deep-equal|Expected values/);
    assert.equal(model.chooseLabel(), 2, "invalid evidence leaves the old label reserved");
  }
  assert.equal(model.release(pane, evidence), true);
  assert.equal(model.release(pane, evidence), true, "an exact duplicate release is idempotent");
});

test("unknown release persistence does not free a label until durable readback confirms it", () => {
  const model = new PaneLabelReuseModel();
  const pane = model.allocate(identity("pane-1"));
  const evidence = closeAndRetire(model, pane);
  assert.equal(model.release(pane, evidence, "unknown"), false);
  assert.equal(model.allocate(identity("pane-2")).paneLabel, 2);
  assert.equal(model.readbackRelease(pane, evidence, true), true);
  assert.equal(model.allocate(identity("pane-3")).paneLabel, 1);
});

test("offline, saved, unknown, and legacy claims reserve their labels", () => {
  const model = new PaneLabelReuseModel();
  model.reserveExisting(1, identity("offline"), "offline");
  model.reserveExisting(2, identity("saved"), "saved");
  model.reserveExisting(3, identity("unknown"), "unknown");
  model.reserveExisting(4, identity("legacy"), "legacy");
  assert.equal(model.allocate(identity("new-pane")).paneLabel, 5);
  assert.throws(() => model.allocate(identity("legacy")), /owner-verified migration/);
});

test("a complete journal may prove a never-claimed lower gap safe", () => {
  const model = new PaneLabelReuseModel({ journalComplete: true });
  model.reserveExisting(1, identity("current-1"));
  model.reserveExisting(3, identity("current-3"));
  assert.equal(model.allocate(identity("new-pane")).paneLabel, 2);
});

test("stable history references never follow a reused number, and old number-only links become ambiguous", () => {
  const model = new PaneLabelReuseModel();
  const oldPane = model.allocate(identity("pane-old"));
  const oldIdentity = identity("pane-old");
  const release = closeAndRetire(model, oldIdentity);
  model.release(oldIdentity, release);
  const newPane = model.allocate(identity("pane-new"));
  assert.equal(newPane.paneLabel, oldPane.paneLabel);
  assert.equal(model.resolveStableReference(oldIdentity, oldPane.allocationGeneration!)?.paneId, "pane-old");
  assert.deepEqual(model.resolveHistoricalNumberOnly(oldPane.paneLabel), { status: "ambiguous" });
  assert.throws(() => model.allocate(oldIdentity), /terminally retired/);
});

test("reconnect preserves a current binding, while a stale backup is history-only after retirement and reuse", () => {
  const model = new PaneLabelReuseModel();
  const oldPane = model.allocate(identity("pane-old"));
  assert.deepEqual(model.allocate(identity("pane-old")), oldPane);
  const release = closeAndRetire(model, oldPane);
  model.release(oldPane, release);
  const newPane = model.allocate(identity("pane-new"));
  const staleProjection = model.restoreBackup(oldPane);
  assert.deepEqual(staleProjection, { status: "history-only", paneLabel: null });
  assert.equal(model.restoreBackup(newPane).status, "live");
});

test("incomplete legacy history uses the monotonic fence instead of guessing that a gap is free", () => {
  const model = new PaneLabelReuseModel({ journalComplete: false });
  model.reserveExisting(1, identity("current-1"));
  model.reserveExisting(3, identity("current-3"));
  assert.equal(model.allocate(identity("new-pane")).paneLabel, 4);
});

test("mixed-version gates and rollback posture disable reuse without erasing release history", () => {
  const gates = {
    allocator: true,
    clients: true,
    backupReaders: false,
    referenceResolvers: true,
    rollbackReaders: true,
  };
  const model = new PaneLabelReuseModel({ gates });
  const first = model.allocate(identity("pane-1"));
  const release = closeAndRetire(model, first);
  model.release(first, release);
  const second = model.allocate(identity("pane-2"));
  assert.equal(second.paneLabel, 2, "an old backup reader keeps the released label out of service");
  assert.equal(model.recordsForLabel(1)[0]?.status, "released", "rollback preserves the durable release history");
});
