use fs2::FileExt;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgementIntent {
    pub scope_id: String,
    pub cursor: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap_generation: Option<u64>,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScopeProjection {
    pub client_cursor: u64,
    pub projected_cursor: u64,
    pub first_retained_sequence: u64,
    pub last_retained_sequence: u64,
    #[serde(default)]
    pub current_content_record: Option<Value>,
    #[serde(default)]
    pub current_content_sequence: Option<u64>,
    #[serde(default)]
    pub records: Vec<Value>,
    #[serde(default)]
    pub gap: Option<Value>,
    #[serde(default)]
    pub synchronized: bool,
    #[serde(default)]
    pub synchronization_cutoff: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CorrelationPhase {
    Prepared,
    Sent,
    ReceiptPersisted,
    ReceiptAcknowledged,
    Unknown(String),
}

impl Serialize for CorrelationPhase {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let value = match self {
            Self::Prepared => "prepared",
            Self::Sent => "sent",
            Self::ReceiptPersisted => "receipt_persisted",
            Self::ReceiptAcknowledged => "receipt_acknowledged",
            Self::Unknown(value) => value.as_str(),
        };
        serializer.serialize_str(value)
    }
}

impl<'de> Deserialize<'de> for CorrelationPhase {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "prepared" => Self::Prepared,
            "sent" => Self::Sent,
            "receipt_persisted" => Self::ReceiptPersisted,
            "receipt_acknowledged" => Self::ReceiptAcknowledged,
            _ => Self::Unknown(value),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedCorrelation {
    pub operation: String,
    pub payload_digest: String,
    pub phase: CorrelationPhase,
    #[serde(default)]
    pub terminal_response: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DurableState {
    pub version: u64,
    pub controller_instance_id: String,
    #[serde(default)]
    pub scopes: BTreeMap<String, ScopeProjection>,
    // Loss for admitted scopes whose payload was never fetched. Keeping this
    // separate prevents metadata from inventing payload cursors or read ACKs.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub unfetched_scope_gaps: BTreeMap<String, Value>,
    #[serde(default)]
    pub acknowledgement_outbox: Vec<AcknowledgementIntent>,
    #[serde(default)]
    pub unresolved: BTreeMap<String, UnresolvedCorrelation>,
    #[serde(default)]
    pub resume_metadata: Value,
}

impl DurableState {
    fn new() -> Self {
        Self {
            version: 1,
            controller_instance_id: format!("ctl_{}", Uuid::new_v4().simple()),
            scopes: BTreeMap::new(),
            unfetched_scope_gaps: BTreeMap::new(),
            acknowledgement_outbox: vec![],
            unresolved: BTreeMap::new(),
            resume_metadata: Value::Object(Default::default()),
        }
    }

    pub fn serialized_bytes(&self) -> Result<usize, serde_json::Error> {
        serde_json::to_vec(self).map(|bytes| bytes.len())
    }
}

pub struct LockedStateRoot {
    root: PathBuf,
    lock: File,
    state: DurableState,
    capacity_bytes: u64,
    original_document: Option<Value>,
    recovery: StateRecovery,
}

#[derive(Default)]
struct StateRecovery {
    warnings: Vec<String>,
    preserve_top_level: BTreeSet<String>,
    opaque_scope_ids: BTreeSet<String>,
    opaque_scope_root: bool,
    opaque_unresolved_ids: BTreeSet<String>,
    opaque_unresolved_root: bool,
    opaque_acknowledgement_scopes: BTreeSet<String>,
    opaque_acknowledgements_block_all: bool,
}

impl LockedStateRoot {
    pub fn open(root: &Path, capacity_bytes: u64) -> Result<Self, StateError> {
        Self::open_with_existing_policy(root, capacity_bytes, false)
    }

    pub fn open_existing(root: &Path, capacity_bytes: u64) -> Result<Self, StateError> {
        Self::open_with_existing_policy(root, capacity_bytes, true)
    }

    fn open_with_existing_policy(
        root: &Path,
        capacity_bytes: u64,
        require_existing: bool,
    ) -> Result<Self, StateError> {
        let state_path = root.join("controller-state.json");
        if require_existing && !state_path.is_file() {
            return Err(StateError::ExistingStateRequired);
        }
        fs::create_dir_all(root)?;
        let lock = OpenOptions::new()
            .create(true)
            .read(true)
            .truncate(false)
            .write(true)
            .open(root.join("invocation.lock"))?;
        lock.lock_exclusive()?;
        let (state, original_document, recovery) = match fs::read(&state_path) {
            Ok(bytes) => {
                let document = serde_json::from_slice::<Value>(&bytes)
                    .map_err(StateError::InvalidState)?;
                let (state, recovery) = recover_state(&document)?;
                (state, Some(document), recovery)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound && require_existing => {
                return Err(StateError::ExistingStateRequired);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                (DurableState::new(), None, StateRecovery::default())
            }
            Err(error) => return Err(error.into()),
        };
        if state.controller_instance_id.is_empty() {
            return Err(StateError::InvalidVersion);
        }
        let mut locked = Self {
            root: root.to_path_buf(),
            lock,
            state,
            capacity_bytes,
            original_document,
            recovery,
        };
        if !state_path.exists() {
            locked.commit()?;
        }
        locked.ensure_capacity()?;
        Ok(locked)
    }

    pub fn state(&self) -> &DurableState {
        &self.state
    }

    pub fn warnings(&self) -> &[String] {
        &self.recovery.warnings
    }

    pub fn has_unresolved_mutation_guard(&self) -> bool {
        self.recovery.opaque_unresolved_root
            || !self.recovery.opaque_unresolved_ids.is_empty()
            || self
                .state
                .unresolved
                .values()
                .any(|correlation| correlation.phase != CorrelationPhase::ReceiptPersisted)
    }

    pub fn acknowledgement_is_guarded(&self, scope_id: &str) -> bool {
        self.recovery.opaque_acknowledgements_block_all
            || self
                .recovery
                .opaque_acknowledgement_scopes
                .contains(scope_id)
    }

    pub fn mutate<T>(
        &mut self,
        operation: impl FnOnce(&mut DurableState) -> T,
    ) -> Result<T, StateError> {
        let mut next = self.state.clone();
        let result = operation(&mut next);
        if self.recovery.opaque_scope_root && next.scopes != self.state.scopes {
            return Err(StateError::UnreadableStateEntry);
        }
        if next.scopes.keys().any(|scope_id| {
            self.recovery.opaque_scope_ids.contains(scope_id)
                && !self.state.scopes.contains_key(scope_id)
        }) {
            return Err(StateError::UnreadableStateEntry);
        }
        Self::ensure_capacity_for(
            &next,
            self.capacity_bytes,
            self.original_document.as_ref(),
            &self.recovery,
        )?;
        self.state = next;
        self.commit()?;
        Ok(result)
    }

    fn ensure_capacity(&self) -> Result<(), StateError> {
        Self::ensure_capacity_for(
            &self.state,
            self.capacity_bytes,
            self.original_document.as_ref(),
            &self.recovery,
        )
    }

    fn ensure_capacity_for(
        state: &DurableState,
        capacity_bytes: u64,
        original_document: Option<&Value>,
        recovery: &StateRecovery,
    ) -> Result<(), StateError> {
        let bytes = serde_json::to_vec(&merged_document(state, original_document, recovery)?)?
            .len() as u64;
        if bytes > capacity_bytes {
            return Err(StateError::ProjectionCapacity {
                actual: bytes,
                maximum: capacity_bytes,
            });
        }
        Ok(())
    }

    fn commit(&mut self) -> Result<(), StateError> {
        let state_path = self.root.join("controller-state.json");
        let temporary = self
            .root
            .join(format!(".controller-state.{}.tmp", Uuid::new_v4().simple()));
        let document = merged_document(
            &self.state,
            self.original_document.as_ref(),
            &self.recovery,
        )?;
        let bytes = serde_json::to_vec_pretty(&document)?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, &state_path)?;
        File::open(&self.root)?.sync_all()?;
        self.original_document = Some(document);
        Ok(())
    }
}

impl Drop for LockedStateRoot {
    fn drop(&mut self) {
        let _ = self.lock.unlock();
    }
}

fn recover_state(document: &Value) -> Result<(DurableState, StateRecovery), StateError> {
    let object = document.as_object().ok_or(StateError::InvalidStateShape)?;
    let version = object
        .get("version")
        .and_then(Value::as_u64)
        .ok_or(StateError::InvalidVersion)?;
    let controller_instance_id = object
        .get("controllerInstanceId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(StateError::InvalidVersion)?
        .to_owned();
    let mut recovery = StateRecovery::default();
    if version != 1 {
        recovery.warnings.push("saved_state_version_unrecognized".into());
    }

    let mut state = DurableState {
        version,
        controller_instance_id,
        scopes: BTreeMap::new(),
        unfetched_scope_gaps: BTreeMap::new(),
        acknowledgement_outbox: Vec::new(),
        unresolved: BTreeMap::new(),
        resume_metadata: object
            .get("resumeMetadata")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new())),
    };

    if let Some(raw_scopes) = object.get("scopes") {
        if let Some(scopes) = raw_scopes.as_object() {
            for (scope_id, raw_scope) in scopes {
                match serde_json::from_value::<ScopeProjection>(raw_scope.clone()) {
                    Ok(scope) => {
                        state.scopes.insert(scope_id.clone(), scope);
                    }
                    Err(_) => {
                        recovery.opaque_scope_ids.insert(scope_id.clone());
                        warn_once(&mut recovery.warnings, "saved_state_scope_unreadable");
                    }
                }
            }
        } else {
            recovery.opaque_scope_root = true;
            recovery.preserve_top_level.insert("scopes".into());
            warn_once(&mut recovery.warnings, "saved_state_scopes_unreadable");
        }
    }

    if let Some(raw_gaps) = object.get("unfetchedScopeGaps") {
        if let Some(gaps) = raw_gaps.as_object() {
            state.unfetched_scope_gaps = gaps
                .iter()
                .map(|(scope_id, gap)| (scope_id.clone(), gap.clone()))
                .collect();
        } else {
            recovery
                .preserve_top_level
                .insert("unfetchedScopeGaps".into());
            warn_once(&mut recovery.warnings, "saved_state_scope_gaps_unreadable");
        }
    }

    if let Some(raw_outbox) = object.get("acknowledgementOutbox") {
        if let Some(outbox) = raw_outbox.as_array() {
            for raw_intent in outbox {
                match serde_json::from_value::<AcknowledgementIntent>(raw_intent.clone()) {
                    Ok(intent) => state.acknowledgement_outbox.push(intent),
                    Err(_) => {
                        warn_once(
                            &mut recovery.warnings,
                            "saved_state_acknowledgement_unreadable",
                        );
                        if let Some(scope_id) = raw_intent
                            .get("scopeId")
                            .and_then(Value::as_str)
                        {
                            recovery
                                .opaque_acknowledgement_scopes
                                .insert(scope_id.to_owned());
                        } else {
                            recovery.opaque_acknowledgements_block_all = true;
                        }
                    }
                }
            }
        } else {
            recovery
                .preserve_top_level
                .insert("acknowledgementOutbox".into());
            recovery.opaque_acknowledgements_block_all = true;
            warn_once(
                &mut recovery.warnings,
                "saved_state_acknowledgements_unreadable",
            );
        }
    }

    if let Some(raw_unresolved) = object.get("unresolved") {
        if let Some(unresolved) = raw_unresolved.as_object() {
            for (request_id, raw_correlation) in unresolved {
                match serde_json::from_value::<UnresolvedCorrelation>(raw_correlation.clone()) {
                    Ok(correlation) => {
                        if matches!(correlation.phase, CorrelationPhase::Unknown(_)) {
                            warn_once(
                                &mut recovery.warnings,
                                "saved_state_correlation_phase_unrecognized",
                            );
                        }
                        state.unresolved.insert(request_id.clone(), correlation);
                    }
                    Err(_) => {
                        recovery.opaque_unresolved_ids.insert(request_id.clone());
                        warn_once(
                            &mut recovery.warnings,
                            "saved_state_correlation_unreadable",
                        );
                    }
                }
            }
        } else {
            recovery.opaque_unresolved_root = true;
            recovery.preserve_top_level.insert("unresolved".into());
            warn_once(
                &mut recovery.warnings,
                "saved_state_correlations_unreadable",
            );
        }
    }

    Ok((state, recovery))
}

fn warn_once(warnings: &mut Vec<String>, warning: &str) {
    if !warnings.iter().any(|existing| existing == warning) {
        warnings.push(warning.to_owned());
    }
}

fn merged_document(
    state: &DurableState,
    original_document: Option<&Value>,
    recovery: &StateRecovery,
) -> Result<Value, serde_json::Error> {
    let serialized = serde_json::to_value(state)?;
    let Some(original) = original_document else {
        return Ok(serialized);
    };
    let mut merged = original.as_object().cloned().unwrap_or_else(Map::new);
    let serialized = serialized
        .as_object()
        .expect("durable state serializes as an object");
    for (key, value) in serialized {
        if recovery.preserve_top_level.contains(key) {
            continue;
        }
        let value = match key.as_str() {
            "scopes" => merge_scope_map(
                original.get(key.as_str()),
                value,
                &recovery.opaque_scope_ids,
            ),
            "acknowledgementOutbox" => {
                merge_acknowledgement_outbox(original.get(key.as_str()), value)
            }
            "unresolved" => merge_unresolved_map(
                original.get(key.as_str()),
                value,
                &recovery.opaque_unresolved_ids,
            ),
            "unfetchedScopeGaps" => value.clone(),
            _ => merge_unknown_object_fields(original.get(key.as_str()), value),
        };
        merged.insert(key.clone(), value);
    }
    if !recovery.preserve_top_level.contains("unfetchedScopeGaps")
        && state.unfetched_scope_gaps.is_empty()
    {
        merged.remove("unfetchedScopeGaps");
    }
    Ok(Value::Object(merged))
}

fn merge_scope_map(
    original: Option<&Value>,
    updated: &Value,
    opaque_scope_ids: &BTreeSet<String>,
) -> Value {
    let Some(updated) = updated.as_object() else {
        return updated.clone();
    };
    let Some(original) = original.and_then(Value::as_object) else {
        return Value::Object(updated.clone());
    };
    let mut merged = Map::new();
    for (scope_id, raw_scope) in original {
        if opaque_scope_ids.contains(scope_id) {
            merged.insert(scope_id.clone(), raw_scope.clone());
            continue;
        }
        if let Some(scope) = updated.get(scope_id) {
            merged.insert(
                scope_id.clone(),
                merge_unknown_object_fields(Some(raw_scope), scope),
            );
        }
    }
    for (scope_id, scope) in updated {
        if !original.contains_key(scope_id) {
            merged.insert(scope_id.clone(), scope.clone());
        }
    }
    Value::Object(merged)
}

fn merge_acknowledgement_outbox(original: Option<&Value>, updated: &Value) -> Value {
    let Some(updated) = updated.as_array() else {
        return updated.clone();
    };
    let Some(original) = original.and_then(Value::as_array) else {
        return Value::Array(updated.clone());
    };
    let mut used = vec![false; updated.len()];
    let mut merged = Vec::new();
    for raw_intent in original {
        let Ok(old_intent) = serde_json::from_value::<AcknowledgementIntent>(raw_intent.clone())
        else {
            merged.push(raw_intent.clone());
            continue;
        };
        let Some((index, current)) = updated.iter().enumerate().find(|(index, intent)| {
            !used[*index]
                && intent.get("idempotencyKey").and_then(Value::as_str)
                    == Some(old_intent.idempotency_key.as_str())
        }) else {
            continue;
        };
        used[index] = true;
        merged.push(merge_unknown_object_fields(Some(raw_intent), current));
    }
    merged.extend(
        updated
            .iter()
            .enumerate()
            .filter(|(index, _)| !used[*index])
            .map(|(_, intent)| intent.clone()),
    );
    Value::Array(merged)
}

fn merge_unresolved_map(
    original: Option<&Value>,
    updated: &Value,
    opaque_unresolved_ids: &BTreeSet<String>,
) -> Value {
    let Some(updated) = updated.as_object() else {
        return updated.clone();
    };
    let Some(original) = original.and_then(Value::as_object) else {
        return Value::Object(updated.clone());
    };
    let mut merged = Map::new();
    for (request_id, raw_correlation) in original {
        if opaque_unresolved_ids.contains(request_id) {
            merged.insert(request_id.clone(), raw_correlation.clone());
        } else if let Some(correlation) = updated.get(request_id) {
            merged.insert(
                request_id.clone(),
                merge_unknown_object_fields(Some(raw_correlation), correlation),
            );
        }
    }
    for (request_id, correlation) in updated {
        if !original.contains_key(request_id) {
            merged.insert(request_id.clone(), correlation.clone());
        }
    }
    Value::Object(merged)
}

fn merge_unknown_object_fields(original: Option<&Value>, updated: &Value) -> Value {
    let (Some(original), Some(updated)) = (original.and_then(Value::as_object), updated.as_object())
    else {
        return updated.clone();
    };
    let mut merged = original.clone();
    for (key, value) in updated {
        merged.insert(key.clone(), value.clone());
    }
    Value::Object(merged)
}

#[derive(Debug)]
pub enum StateError {
    Io(io::Error),
    InvalidState(serde_json::Error),
    InvalidStateShape,
    InvalidVersion,
    UnreadableStateEntry,
    ExistingStateRequired,
    Json(serde_json::Error),
    ProjectionCapacity { actual: u64, maximum: u64 },
}

impl std::fmt::Display for StateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "state_io:{error}"),
            Self::InvalidState(error) => write!(formatter, "invalid_state:{error}"),
            Self::InvalidStateShape => formatter.write_str("invalid_state_shape"),
            Self::InvalidVersion => formatter.write_str("invalid_state_version"),
            Self::UnreadableStateEntry => {
                formatter.write_str("saved_state_entry_unreadable")
            }
            Self::ExistingStateRequired => formatter.write_str("state_root_not_initialized"),
            Self::Json(error) => write!(formatter, "state_json:{error}"),
            Self::ProjectionCapacity { actual, maximum } => {
                write!(formatter, "projection_capacity:{actual}:{maximum}")
            }
        }
    }
}

impl std::error::Error for StateError {}

impl From<io::Error> for StateError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for StateError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}
