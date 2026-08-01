use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
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
    pub records: Vec<Value>,
    #[serde(default)]
    pub gap: Option<Value>,
    #[serde(default)]
    pub synchronized: bool,
    #[serde(default)]
    pub synchronization_cutoff: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CorrelationPhase {
    Prepared,
    Sent,
    ReceiptPersisted,
    ReceiptAcknowledged,
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
    pub version: u8,
    pub controller_instance_id: String,
    #[serde(default)]
    pub scopes: BTreeMap<String, ScopeProjection>,
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
}

impl LockedStateRoot {
    pub fn open(root: &Path, capacity_bytes: u64) -> Result<Self, StateError> {
        fs::create_dir_all(root)?;
        let lock = OpenOptions::new()
            .create(true)
            .read(true)
            .truncate(false)
            .write(true)
            .open(root.join("invocation.lock"))?;
        lock.lock_exclusive()?;
        let state_path = root.join("controller-state.json");
        let state = match fs::read(&state_path) {
            Ok(bytes) => {
                serde_json::from_slice::<DurableState>(&bytes).map_err(StateError::InvalidState)?
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => DurableState::new(),
            Err(error) => return Err(error.into()),
        };
        if state.version != 1 || state.controller_instance_id.is_empty() {
            return Err(StateError::InvalidVersion);
        }
        let locked = Self {
            root: root.to_path_buf(),
            lock,
            state,
            capacity_bytes,
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

    pub fn mutate<T>(
        &mut self,
        operation: impl FnOnce(&mut DurableState) -> T,
    ) -> Result<T, StateError> {
        let mut next = self.state.clone();
        let result = operation(&mut next);
        Self::ensure_capacity_for(&next, self.capacity_bytes)?;
        self.state = next;
        self.commit()?;
        Ok(result)
    }

    fn ensure_capacity(&self) -> Result<(), StateError> {
        Self::ensure_capacity_for(&self.state, self.capacity_bytes)
    }

    fn ensure_capacity_for(state: &DurableState, capacity_bytes: u64) -> Result<(), StateError> {
        let bytes = state.serialized_bytes()? as u64;
        if bytes > capacity_bytes {
            return Err(StateError::ProjectionCapacity {
                actual: bytes,
                maximum: capacity_bytes,
            });
        }
        Ok(())
    }

    fn commit(&self) -> Result<(), StateError> {
        let state_path = self.root.join("controller-state.json");
        let temporary = self
            .root
            .join(format!(".controller-state.{}.tmp", Uuid::new_v4().simple()));
        let bytes = serde_json::to_vec_pretty(&self.state)?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, &state_path)?;
        File::open(&self.root)?.sync_all()?;
        Ok(())
    }
}

impl Drop for LockedStateRoot {
    fn drop(&mut self) {
        let _ = self.lock.unlock();
    }
}

#[derive(Debug)]
pub enum StateError {
    Io(io::Error),
    InvalidState(serde_json::Error),
    InvalidVersion,
    Json(serde_json::Error),
    ProjectionCapacity { actual: u64, maximum: u64 },
}

impl std::fmt::Display for StateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "state_io:{error}"),
            Self::InvalidState(error) => write!(formatter, "invalid_state:{error}"),
            Self::InvalidVersion => formatter.write_str("invalid_state_version"),
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
