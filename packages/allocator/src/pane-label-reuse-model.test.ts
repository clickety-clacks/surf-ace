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
type PaneStatus = "active" | "recoverable" | "retirement-unknown" | "terminal-retired" | "released" | "offline" | "saved" | "unknown" | "legacy";
type TombstoneKind = "pane" | "surface";
type Tombstone = {
  id: string;
  kind: TombstoneKind;
  closedSequence: number;
  paneKeys: string[];
  status: "recoverable" | "reclamation-unknown";
  surfaceLivePaneKeys?: string[];
  nestedPaneTombstones?: Array<{
    id: string;
    kind: "pane";
    closedSequence: number;
    paneKeys: string[];
    status: "recoverable";
  }>;
};
type PaneRecord = PaneIdentity & {
  paneLabel: number;
  allocationGeneration: number | null;
  status: PaneStatus;
  tombstoneId: string | null;
  retirementTombstoneKind: TombstoneKind | null;
  closeRevision: number | null;
  terminalRetirementRevision: number | null;
  pendingRetirementReadback: boolean;
  pendingRelease: boolean;
  contentAvailable: boolean;
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
  tombstoneKind: TombstoneKind | null;
  closeRevision: number | null;
  terminalRetirementRevision: number | null;
  idempotencyKey: string;
};
type RetirementAudit = {
  paneLabel: number;
  allocationGeneration: number;
  tombstoneId: string;
  tombstoneKind: TombstoneKind;
  closeRevision: number;
  terminalRetirementRevision: number;
  releaseIntentCommitted: true;
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
  tombstones: Map<string, Tombstone>;
  nextClosedSequence: number;
  retirementAudit: Map<string, RetirementAudit>;

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
    this.tombstones = new Map();
    this.nextClosedSequence = 0;
    this.retirementAudit = new Map();
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
      retirementTombstoneKind: null,
      closeRevision: null,
      terminalRetirementRevision: null,
      pendingRetirementReadback: false,
      pendingRelease: false,
      contentAvailable: true,
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
    if (this.retirementAudit.has(identityKey(identityValue))) {
      throw new Error("terminally retired pane identity cannot be claimed");
    }
    const previous = this.recordFor(identityValue);
    if (previous) {
      if (previous.pendingRetirementReadback) throw new Error("retirement persistence requires authoritative readback");
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
      retirementTombstoneKind: null,
      closeRevision: null,
      terminalRetirementRevision: null,
      pendingRetirementReadback: false,
      pendingRelease: false,
      contentAvailable: true,
    };
    this.addRecord(record);
    this.nextPaneLabelFence = Math.max(this.nextPaneLabelFence, paneLabel + 1);
    return this.view(record);
  }

  close(identityValue: PaneIdentity, tombstoneId: string, closeRevision: number): AllocationView {
    const record = this.recordFor(identityValue);
    assert.ok(record && record.status === "active");
    assert.equal(this.tombstones.has(tombstoneId), false);
    record.status = "recoverable";
    record.tombstoneId = tombstoneId;
    record.closeRevision = closeRevision;
    this.addTombstone(tombstoneId, "pane", [record]);
    return this.view(record);
  }

  closeSurface(tombstoneId: string, closeRevision: number, identities: PaneIdentity[]): void {
    assert.ok(identities.length > 0);
    assert.equal(new Set(identities.map(identityKey)).size, identities.length);
    assert.equal(this.tombstones.has(tombstoneId), false);
    const records: PaneRecord[] = [];
    const surfaceLivePaneKeys: string[] = [];
    const nestedPaneTombstones: NonNullable<Tombstone["nestedPaneTombstones"]> = [];
    for (const identityValue of identities) {
      const record = this.recordFor(identityValue);
      assert.ok(record && ["active", "recoverable"].includes(record.status));
      if (record.status === "active") {
        assert.equal(record.tombstoneId, null);
        surfaceLivePaneKeys.push(identityKey(record));
      } else {
        const nested = this.tombstones.get(record.tombstoneId);
        assert.ok(nested && nested.kind === "pane" && nested.status === "recoverable");
        assert.equal(nested.paneKeys.length, 1);
        assert.equal(nested.paneKeys[0], identityKey(record));
        nestedPaneTombstones.push({
          id: nested.id,
          kind: "pane",
          closedSequence: nested.closedSequence,
          paneKeys: [...nested.paneKeys],
          status: "recoverable",
        });
      }
      records.push(record);
    }
    for (const nested of nestedPaneTombstones) this.tombstones.delete(nested.id);
    for (const record of records.filter((pane) => pane.status === "active")) {
      record.status = "recoverable";
      record.tombstoneId = tombstoneId;
      record.closeRevision = closeRevision;
    }
    this.nextClosedSequence += 1;
    const closedSequence = this.nextClosedSequence;
    this.tombstones.set(tombstoneId, {
      id: tombstoneId,
      kind: "surface",
      closedSequence,
      paneKeys: records.map(identityKey),
      surfaceLivePaneKeys,
      nestedPaneTombstones,
      status: "recoverable",
    });
  }

  addTombstone(id: string, kind: TombstoneKind, records: PaneRecord[]): void {
    this.nextClosedSequence += 1;
    this.tombstones.set(id, {
      id,
      kind,
      closedSequence: this.nextClosedSequence,
      paneKeys: records.map(identityKey),
      status: "recoverable",
    });
  }

  disconnect(identityValue: PaneIdentity): AllocationView {
    const record = this.recordFor(identityValue);
    assert.ok(record && ["active", "recoverable"].includes(record.status));
    return this.view(record);
  }

  restore(identityValue: PaneIdentity): AllocationView {
    const record = this.recordFor(identityValue);
    if (!record || record.status !== "recoverable") throw new Error("pane is not restorable");
    const tombstone = record.tombstoneId ? this.tombstones.get(record.tombstoneId) : undefined;
    if (!tombstone || tombstone.kind !== "pane" || tombstone.status !== "recoverable") {
      throw new Error("pane is not restorable from this tombstone");
    }
    this.tombstones.delete(tombstone.id);
    record.status = "active";
    record.tombstoneId = null;
    record.closeRevision = null;
    return this.view(record);
  }

  restoreSurface(tombstoneId: string): AllocationView[] {
    const tombstone = this.tombstones.get(tombstoneId);
    if (!tombstone || tombstone.kind !== "surface" || tombstone.status !== "recoverable") {
      throw new Error("surface tombstone is not restorable");
    }
    const records = tombstone.paneKeys.map((key) => this.byIdentity.get(key));
    const livePaneKeys = new Set(tombstone.surfaceLivePaneKeys ?? tombstone.paneKeys);
    const nestedByPane = new Map((tombstone.nestedPaneTombstones ?? [])
      .flatMap((nested) => nested.paneKeys.map((key) => [key, nested] as const)));
    assert.ok(records.every((record) => {
      if (!record || record.status !== "recoverable") return false;
      if (livePaneKeys.has(identityKey(record))) return record.tombstoneId === tombstoneId;
      const nested = nestedByPane.get(identityKey(record));
      return nested !== undefined && record.tombstoneId === nested.id;
    }));
    assert.ok((tombstone.nestedPaneTombstones ?? []).every((nested) => !this.tombstones.has(nested.id)));
    this.tombstones.delete(tombstoneId);
    for (const record of records) {
      assert.ok(record);
      if (livePaneKeys.has(identityKey(record))) {
        record.status = "active";
        record.tombstoneId = null;
        record.closeRevision = null;
      }
    }
    for (const nested of tombstone.nestedPaneTombstones ?? []) {
      this.tombstones.set(nested.id, {
        ...nested,
        paneKeys: [...nested.paneKeys],
      });
    }
    return records.map((record) => this.view(record!));
  }

  reclaimTombstone(tombstoneId: string, retirementRevision: number, persistence: "committed" | "rolled-back" | "unknown" = "committed"): boolean {
    const tombstone = this.tombstones.get(tombstoneId);
    if (!tombstone) throw new Error("tombstone is not retained");
    if (tombstone.status !== "recoverable") throw new Error("reclamation persistence requires authoritative readback");
    const oldest = [...this.tombstones.values()].sort((left, right) => left.closedSequence - right.closedSequence)[0];
    assert.equal(tombstone.id, oldest?.id, "retention must reclaim the existing oldest tombstone first");
    if (persistence === "rolled-back") return false;
    if (persistence === "unknown") {
      const records = tombstone.paneKeys.map((key) => this.byIdentity.get(key));
      assert.ok(records.every((record) => record && record.status === "recoverable"));
      tombstone.status = "reclamation-unknown";
      for (const record of records) {
        assert.ok(record);
        record.status = "retirement-unknown";
        record.pendingRetirementReadback = true;
      }
      return false;
    }
    this.commitRetirement(tombstone, retirementRevision);
    return true;
  }

  readbackReclamation(tombstoneId: string, committed: boolean, retirementRevision: number): boolean {
    const tombstone = this.tombstones.get(tombstoneId);
    assert.ok(tombstone && tombstone.status === "reclamation-unknown");
    for (const key of tombstone.paneKeys) {
      const record = this.byIdentity.get(key);
      assert.ok(record && record.status === "retirement-unknown" && record.pendingRetirementReadback);
    }
    if (committed) {
      this.commitRetirement(tombstone, retirementRevision);
      return true;
    }
    tombstone.status = "recoverable";
    for (const key of tombstone.paneKeys) {
      const record = this.byIdentity.get(key);
      assert.ok(record);
      record.status = "recoverable";
      record.pendingRetirementReadback = false;
    }
    return false;
  }

  commitRetirement(tombstone: Tombstone, retirementRevision: number): void {
    const records = tombstone.paneKeys.map((key) => this.byIdentity.get(key));
    const nestedByPane = new Map((tombstone.nestedPaneTombstones ?? [])
      .flatMap((nested) => nested.paneKeys.map((key) => [key, nested] as const)));
    assert.ok(records.every((record) => {
      if (!record || !["recoverable", "retirement-unknown"].includes(record.status)
          || record.closeRevision === null) return false;
      const nested = nestedByPane.get(identityKey(record));
      const expectedTombstoneId = nested?.id ?? tombstone.id;
      return record.tombstoneId === expectedTombstoneId;
    }));
    for (const record of records) {
      assert.ok(record);
      const key = identityKey(record);
      const allocationGeneration = record.allocationGeneration;
      if (allocationGeneration === null) {
        // Reclamation may remove legacy content, but it cannot prove a legacy
        // allocation terminal or release its number without owner verification.
        record.status = "legacy";
        record.pendingRetirementReadback = false;
        record.contentAvailable = false;
        continue;
      }
      record.status = "terminal-retired";
      record.retirementTombstoneKind = tombstone.kind;
      record.terminalRetirementRevision = retirementRevision;
      record.pendingRetirementReadback = false;
      record.contentAvailable = false;
      this.retirementAudit.set(key, {
        paneLabel: record.paneLabel,
        allocationGeneration,
        tombstoneId: tombstone.id,
        tombstoneKind: tombstone.kind,
        closeRevision: record.closeRevision,
        terminalRetirementRevision: retirementRevision,
        releaseIntentCommitted: true,
      });
    }
    this.tombstones.delete(tombstone.id);
  }

  releaseEvidence(record: PaneRecord): ReleaseEvidence {
    const audit = this.retirementAudit.get(identityKey(record));
    if (record.allocationGeneration === null) throw new Error("legacy allocation has no generation");
    if (!["terminal-retired", "released"].includes(record.status)
      || record.pendingRetirementReadback || !audit?.releaseIntentCommitted) {
      throw new Error("durable terminal retirement and release intent are required");
    }
    return {
      ...stableIdentity(record),
      paneLabel: record.paneLabel,
      allocationGeneration: audit.allocationGeneration,
      tombstoneId: audit.tombstoneId,
      tombstoneKind: audit.tombstoneKind,
      closeRevision: audit.closeRevision,
      terminalRetirementRevision: audit.terminalRetirementRevision,
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

  restoreBackup(snapshot: AllocationView): { status: "history-only" | "pending-readback"; paneLabel: null } | { status: "live"; paneLabel: number; allocationGeneration: number } {
    const audit = this.retirementAudit.get(identityKey(snapshot));
    if (audit && audit.paneLabel === snapshot.paneLabel && audit.allocationGeneration === snapshot.allocationGeneration) {
      return { status: "history-only", paneLabel: null };
    }
    const records = this.recordsForLabel(snapshot.paneLabel);
    const exact = records.find((record) => identityKey(record) === identityKey(snapshot)
      && record.allocationGeneration === snapshot.allocationGeneration);
    if (exact?.pendingRetirementReadback || exact?.status === "retirement-unknown") {
      return { status: "pending-readback", paneLabel: null };
    }
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
  const tombstoneId = `tombstone-${pane.paneId}`;
  model.close(pane, tombstoneId, closeRevision);
  assert.equal(model.reclaimTombstone(tombstoneId, closeRevision + 1), true);
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
  assert.equal(model.reclaimTombstone("tombstone-pane-1", 11, "rolled-back"), false);
  assert.equal(model.chooseLabel(), 3, "a rolled-back reclamation leaves the label reserved");
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
    { ...evidence, tombstoneKind: "surface" as const },
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
  assert.equal(model.recordFor(oldPane)?.contentAvailable, false, "tombstone content is gone while durable retirement audit remains");
  assert.equal(model.retirementAudit.has(identityKey(oldPane)), true);
  assert.equal(model.restoreBackup(newPane).status, "live");
});

test("restore and reclamation obey one client order, and only the existing oldest tombstone can be reclaimed", () => {
  const model = new PaneLabelReuseModel();
  const restoredPane = model.allocate(identity("restore-first"));
  const firstId = "tombstone-restore-first";
  model.close(restoredPane, firstId, 10);
  assert.equal(model.restore(restoredPane).status, "active");
  assert.throws(() => model.reclaimTombstone(firstId, 11), /not retained/);

  const oldestPane = model.allocate(identity("oldest"));
  const laterPane = model.allocate(identity("later"));
  const oldestId = "tombstone-oldest";
  const laterId = "tombstone-later";
  model.close(oldestPane, oldestId, 12);
  model.close(laterPane, laterId, 13);
  assert.throws(() => model.reclaimTombstone(laterId, 14), /oldest tombstone/);
  assert.equal(model.reclaimTombstone(oldestId, 14, "rolled-back"), false);
  assert.equal(model.chooseLabel(), 4, "rolled-back retention work releases neither label");
  assert.equal(model.restoreBackup(oldestPane).status, "live", "the still-retained oldest pane remains restorable");
  assert.equal(model.restore(oldestPane).status, "active");
});

test("surface tombstone keeps every nested pane reserved until restored or reclaimed together", () => {
  const model = new PaneLabelReuseModel();
  const first = model.allocate(identity("surface-pane-1"));
  const second = model.allocate(identity("surface-pane-2"));
  model.close(first, "nested-pane-tombstone", 19);
  const surfaceTombstone = "surface-tombstone-a";
  model.closeSurface(surfaceTombstone, 20, [first, second]);
  assert.equal(model.chooseLabel(), 3, "the surface tombstone reserves all nested pane labels");
  assert.throws(() => model.restore(first), /not restorable from this tombstone/);
  const retainedSurface = model.tombstones.get(surfaceTombstone);
  assert.equal(retainedSurface?.closedSequence, 2, "the surface keeps its fresh close-time retention position");
  assert.deepEqual(retainedSurface?.nestedPaneTombstones, [{
    id: "nested-pane-tombstone",
    kind: "pane",
    closedSequence: 1,
    paneKeys: [identityKey(first)],
    status: "recoverable",
  }]);
  assert.equal(model.restoreSurface(surfaceTombstone).length, 2);
  assert.equal(model.recordFor(first)?.allocationGeneration, first.allocationGeneration);
  assert.equal(model.recordFor(first)?.status, "recoverable", "surface restore preserves the child's earlier pane close");
  assert.equal(model.recordFor(first)?.tombstoneId, "nested-pane-tombstone");
  assert.equal(model.recordFor(first)?.closeRevision, 19);
  assert.equal(model.recordFor(second)?.status, "active", "the child that was live at surface close is restored");
  assert.equal(model.tombstones.get("nested-pane-tombstone")?.closedSequence, 1);
  assert.equal(model.chooseLabel(), 3, "restoring a surface preserves both pane allocations");

  const reclaimedSurface = "surface-tombstone-b";
  model.closeSurface(reclaimedSurface, 21, [first, second]);
  assert.equal(model.reclaimTombstone(reclaimedSurface, 22), true);
  assert.throws(() => model.restoreSurface(reclaimedSurface), /not restorable/);
  assert.throws(() => model.restore(first), /not restorable/);
  const firstRelease = model.releaseEvidence(model.recordFor(first)!);
  const secondRelease = model.releaseEvidence(model.recordFor(second)!);
  assert.equal(firstRelease.tombstoneKind, "surface");
  assert.equal(secondRelease.tombstoneKind, "surface");
  assert.equal(model.release(first, firstRelease), true);
  assert.equal(model.release(second, secondRelease), true);
  const newFirst = model.allocate(identity("surface-pane-new-1"));
  const newSecond = model.allocate(identity("surface-pane-new-2"));
  assert.equal(newFirst.paneLabel, 1);
  assert.equal(newSecond.paneLabel, 2);
  assert.ok(newFirst.allocationGeneration > first.allocationGeneration);
});

test("surface close keeps its fresh retention position ahead of an older unrelated tombstone", () => {
  const model = new PaneLabelReuseModel();
  const nestedChild = model.allocate(identity("interleaved-nested-child"));
  const unrelated = model.allocate(identity("interleaved-unrelated"));
  const liveChild = model.allocate(identity("interleaved-live-child"));
  model.close(nestedChild, "interleaved-nested-tombstone", 30); // sequence 1
  model.close(unrelated, "interleaved-unrelated-tombstone", 31); // sequence 2
  model.closeSurface("interleaved-surface-tombstone", 32, [nestedChild, liveChild]); // sequence 3

  const surface = model.tombstones.get("interleaved-surface-tombstone");
  assert.equal(surface?.closedSequence, 3, "the parent uses the sequence assigned when the surface closes");
  assert.equal(surface?.nestedPaneTombstones?.[0]?.closedSequence, 1, "the child keeps its original sequence as nested metadata");
  assert.throws(() => model.reclaimTombstone("interleaved-surface-tombstone", 33), /oldest tombstone/);
  assert.equal(model.reclaimTombstone("interleaved-unrelated-tombstone", 33), true);
  assert.equal(model.reclaimTombstone("interleaved-surface-tombstone", 34), true);
});

test("unknown client reclamation persistence holds allocation until readback decides restore or retirement", () => {
  const rolledBack = new PaneLabelReuseModel();
  const recoverable = rolledBack.allocate(identity("readback-restore"));
  const recoverableTombstone = "tombstone-readback-restore";
  rolledBack.close(recoverable, recoverableTombstone, 30);
  assert.equal(rolledBack.reclaimTombstone(recoverableTombstone, 31, "unknown"), false);
  assert.equal(rolledBack.chooseLabel(), 2);
  assert.deepEqual(rolledBack.restoreBackup(recoverable), { status: "pending-readback", paneLabel: null });
  assert.throws(() => rolledBack.restore(recoverable), /not restorable/);
  assert.throws(() => rolledBack.allocate(recoverable), /readback/);
  assert.throws(() => rolledBack.releaseEvidence(rolledBack.recordFor(recoverable)!), /durable terminal retirement/);
  assert.equal(rolledBack.readbackReclamation(recoverableTombstone, false, 31), false);
  assert.deepEqual(rolledBack.restoreBackup(recoverable), {
    status: "live",
    paneLabel: recoverable.paneLabel,
    allocationGeneration: recoverable.allocationGeneration,
  });
  assert.equal(rolledBack.restore(recoverable).status, "active");

  const committed = new PaneLabelReuseModel();
  const retired = committed.allocate(identity("readback-retired"));
  const retiredTombstone = "tombstone-readback-retired";
  committed.close(retired, retiredTombstone, 32);
  assert.equal(committed.reclaimTombstone(retiredTombstone, 33, "unknown"), false);
  assert.deepEqual(committed.restoreBackup(retired), { status: "pending-readback", paneLabel: null });
  assert.equal(committed.readbackReclamation(retiredTombstone, true, 33), true);
  assert.deepEqual(committed.restoreBackup(retired), { status: "history-only", paneLabel: null });
  assert.equal(committed.release(retired, committed.releaseEvidence(committed.recordFor(retired)!)), true);
  assert.equal(committed.allocate(identity("after-readback")).paneLabel, 1);
  assert.throws(() => committed.allocate(retired), /terminally retired/);
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
