use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use chrono::{SecondsFormat, Utc};
use serde_json::{Map, Value, json};
use tempfile::NamedTempFile;
use thiserror::Error;
use uuid::Uuid;

const SCHEMA_VERSION: u64 = 2;

#[derive(Debug, Error)]
pub enum MemoryError {
    #[error("memory root must be a JSON object")]
    InvalidRoot,
    #[error("memory field `{0}` has an invalid shape")]
    InvalidField(&'static str),
    #[error("failed to read memory file `{path}`: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse memory file `{path}`: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("failed to write memory file `{path}`: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub fn default_memory() -> Value {
    let now = timestamp();
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "locations": {},
        "players": {},
        "currentTask": null,
        "rules": [],
        "learnedFacts": {},
        "metadata": default_metadata(&now)
    })
}

pub fn normalize_memory(value: Value) -> Result<Value, MemoryError> {
    let mut memory = value.as_object().cloned().ok_or(MemoryError::InvalidRoot)?;
    let now = timestamp();
    memory.insert("schemaVersion".to_owned(), json!(SCHEMA_VERSION));
    normalize_object_field(&mut memory, "locations")?;
    normalize_object_field(&mut memory, "players")?;

    let rules = memory
        .entry("rules")
        .or_insert_with(|| Value::Array(Vec::new()));
    let rules = rules
        .as_array_mut()
        .ok_or(MemoryError::InvalidField("rules"))?;
    for (index, rule) in rules.iter_mut().enumerate() {
        if let Some(text) = rule.as_str().map(str::to_owned) {
            *rule = json!({
                "id": format!("rule_migrated_{index}"),
                "rule": text.chars().take(300).collect::<String>(),
                "category": "general",
                "enabled": true,
                "createdAt": now,
                "updatedAt": now,
                "author": "migration"
            });
        }
    }

    let facts = memory
        .entry("learnedFacts".to_owned())
        .or_insert_with(|| json!({}));
    let facts = facts
        .as_object_mut()
        .ok_or(MemoryError::InvalidField("learnedFacts"))?;
    for (key, fact) in facts.iter_mut() {
        if let Some(text) = fact.as_str().map(str::to_owned) {
            *fact = json!({
                "key": key,
                "value": text.chars().take(500).collect::<String>(),
                "category": "general",
                "confidence": 1.0,
                "source": "migration",
                "createdAt": now,
                "updatedAt": now,
                "accessCount": 0,
                "lastAccessedAt": now
            });
        }
    }

    if !memory.contains_key("currentTask") {
        memory.insert("currentTask".to_owned(), Value::Null);
    }
    if memory
        .get("metadata")
        .is_some_and(|metadata| !metadata.is_object())
    {
        return Err(MemoryError::InvalidField("metadata"));
    }
    normalize_metadata(&mut memory, &now)?;

    Ok(Value::Object(memory))
}

pub fn load_memory(path: impl AsRef<Path>) -> Result<Value, MemoryError> {
    let path = path.as_ref();
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(default_memory()),
        Err(source) => {
            return Err(MemoryError::Read {
                path: path.to_owned(),
                source,
            });
        }
    };

    let value = serde_json::from_str(&content).map_err(|source| MemoryError::Parse {
        path: path.to_owned(),
        source,
    })?;
    normalize_memory(value)
}

pub fn save_memory(path: impl AsRef<Path>, data: &Value) -> Result<(), MemoryError> {
    let path = path.as_ref();
    let normalized = normalize_memory(data.clone())?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    if let Some(parent) = parent {
        fs::create_dir_all(parent).map_err(|source| MemoryError::Write {
            path: parent.to_owned(),
            source,
        })?;
    }

    let directory = parent.unwrap_or_else(|| Path::new("."));
    let mut temporary = NamedTempFile::new_in(directory).map_err(|source| MemoryError::Write {
        path: path.to_owned(),
        source,
    })?;
    serde_json::to_writer_pretty(&mut temporary, &normalized).map_err(|source| {
        MemoryError::Write {
            path: path.to_owned(),
            source: std::io::Error::other(source),
        }
    })?;
    temporary
        .write_all(b"\n")
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|source| MemoryError::Write {
            path: path.to_owned(),
            source,
        })?;
    temporary
        .persist(path)
        .map_err(|error| MemoryError::Write {
            path: path.to_owned(),
            source: error.error,
        })?;
    Ok(())
}

pub fn remember_fact(data: &mut Value, key: &str, fact: &str) -> Result<bool, MemoryError> {
    let memory = data.as_object_mut().ok_or(MemoryError::InvalidRoot)?;
    let key: String = key.trim().chars().take(80).collect();
    let fact: String = fact.trim().chars().take(500).collect();
    if key.is_empty() || fact.is_empty() {
        return Ok(false);
    }

    let facts = memory
        .entry("learnedFacts".to_owned())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or(MemoryError::InvalidField("learnedFacts"))?;
    let now = timestamp();
    let mut entry = facts
        .get(&key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    entry.insert("key".to_owned(), json!(key));
    entry.insert("value".to_owned(), json!(fact));
    entry
        .entry("category".to_owned())
        .or_insert_with(|| json!("general"));
    entry
        .entry("confidence".to_owned())
        .or_insert_with(|| json!(1.0));
    entry
        .entry("source".to_owned())
        .or_insert_with(|| json!("user"));
    entry
        .entry("createdAt".to_owned())
        .or_insert_with(|| json!(now));
    entry.insert("updatedAt".to_owned(), json!(now));
    entry
        .entry("accessCount".to_owned())
        .or_insert_with(|| json!(0));
    entry
        .entry("lastAccessedAt".to_owned())
        .or_insert_with(|| json!(now));
    facts.insert(key, Value::Object(entry));
    Ok(true)
}

pub fn forget_fact(data: &mut Value, key: &str) -> Result<bool, MemoryError> {
    let memory = data.as_object_mut().ok_or(MemoryError::InvalidRoot)?;
    let facts = memory
        .entry("learnedFacts".to_owned())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or(MemoryError::InvalidField("learnedFacts"))?;
    Ok(facts.remove(key.trim()).is_some())
}

fn normalize_object_field(
    memory: &mut Map<String, Value>,
    name: &'static str,
) -> Result<(), MemoryError> {
    let value = memory.entry(name.to_owned()).or_insert_with(|| json!({}));
    if value.is_object() {
        Ok(())
    } else {
        Err(MemoryError::InvalidField(name))
    }
}

fn default_metadata(now: &str) -> Value {
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "createdAt": now,
        "updatedAt": now,
        "migrationHistory": [],
        "stats": {
            "totalLocations": 0,
            "totalPlayers": 0,
            "totalFacts": 0,
            "totalRules": 0,
            "totalTasks": 0,
            "lastCleanupAt": now,
            "lastBackupAt": now
        }
    })
}

fn normalize_metadata(memory: &mut Map<String, Value>, now: &str) -> Result<(), MemoryError> {
    let location_count = memory
        .get("locations")
        .and_then(Value::as_object)
        .map_or(0, |locations| locations.len());
    let player_count = memory
        .get("players")
        .and_then(Value::as_object)
        .map_or(0, |players| players.len());
    let fact_count = memory
        .get("learnedFacts")
        .and_then(Value::as_object)
        .map_or(0, |facts| facts.len());
    let rule_count = memory
        .get("rules")
        .and_then(Value::as_array)
        .map_or(0, |rules| rules.len());
    let task_count = if memory
        .get("currentTask")
        .is_some_and(|task| !task.is_null())
    {
        1
    } else {
        0
    };
    let metadata = memory
        .entry("metadata".to_owned())
        .or_insert_with(|| default_metadata(now));
    let metadata = metadata
        .as_object_mut()
        .ok_or(MemoryError::InvalidField("metadata"))?;

    metadata.insert("schemaVersion".to_owned(), json!(SCHEMA_VERSION));
    if !metadata.get("createdAt").is_some_and(Value::is_string) {
        metadata.insert("createdAt".to_owned(), json!(now));
    }
    metadata.insert("updatedAt".to_owned(), json!(now));
    if !metadata
        .get("migrationHistory")
        .is_some_and(Value::is_array)
    {
        metadata.insert("migrationHistory".to_owned(), json!([]));
    }

    let stats = metadata
        .entry("stats".to_owned())
        .or_insert_with(|| json!({}));
    if !stats.is_object() {
        *stats = json!({});
    }
    let stats = stats
        .as_object_mut()
        .ok_or(MemoryError::InvalidField("metadata"))?;
    stats.insert("totalLocations".to_owned(), json!(location_count));
    stats.insert("totalPlayers".to_owned(), json!(player_count));
    stats.insert("totalFacts".to_owned(), json!(fact_count));
    stats.insert("totalRules".to_owned(), json!(rule_count));
    stats.insert("totalTasks".to_owned(), json!(task_count));
    if !stats.get("lastCleanupAt").is_some_and(Value::is_string) {
        stats.insert("lastCleanupAt".to_owned(), json!(now));
    }
    if !stats.get("lastBackupAt").is_some_and(Value::is_string) {
        stats.insert("lastBackupAt".to_owned(), json!(now));
    }
    Ok(())
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Memory struct providing a convenient interface for memory operations
#[derive(Debug, Clone)]
pub struct Memory {
    data: Value,
}

impl Default for Memory {
    fn default() -> Self {
        Self {
            data: default_memory(),
        }
    }
}

impl std::ops::Deref for Memory {
    type Target = Value;

    fn deref(&self) -> &Self::Target {
        &self.data
    }
}

impl Memory {
    /// Load memory from file
    pub async fn load(path: impl AsRef<Path> + Send) -> Result<Self, MemoryError> {
        let data = tokio::task::spawn_blocking(move || load_memory(path)).await.unwrap()?;
        Ok(Self { data })
    }

    /// Save memory to file
    pub async fn save(&self, path: impl AsRef<Path> + Send) -> Result<(), MemoryError> {
        let data = self.data.clone();
        tokio::task::spawn_blocking(move || save_memory(path, &data)).await.unwrap()
    }

    /// Save a location
    pub fn save_location(
        &mut self,
        name: &str,
        pos: crate::web::socket::events::BotPosition,
        location_type: &str,
    ) {
        let locations = self
            .data
            .as_object_mut()
            .unwrap()
            .entry("locations".to_owned())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .unwrap();
        let now = timestamp();
        locations.insert(
            name.to_owned(),
            json!({
                "x": pos.x,
                "y": pos.y,
                "z": pos.z,
                "dimension": "overworld",
                "type": location_type,
                "createdAt": now,
                "updatedAt": now,
            }),
        );
    }

    /// Get context for AI
    pub fn get_context(&self) -> String {
        let mut parts = Vec::new();

        if let Some(locations) = self.data["locations"].as_object() {
            for (name, loc) in locations {
                parts.push(format!(
                    "Location {}: X={} Y={} Z={} (type: {})",
                    name,
                    loc["x"].as_f64().unwrap_or(0.0),
                    loc["y"].as_f64().unwrap_or(0.0),
                    loc["z"].as_f64().unwrap_or(0.0),
                    loc["type"].as_str().unwrap_or("waypoint")
                ));
            }
        }

        if let Some(facts) = self.data["learnedFacts"].as_object() {
            for (key, fact) in facts {
                parts.push(format!(
                    "Fact {}: {}",
                    key,
                    fact["value"].as_str().unwrap_or("")
                ));
            }
        }

        if let Some(rules) = self.data["rules"].as_array() {
            for rule in rules {
                parts.push(format!("Rule: {}", rule["rule"].as_str().unwrap_or("")));
            }
        }

        parts.join("\n")
    }

    /// Remember a fact
    pub fn remember_fact(&mut self, key: &str, fact: &str) -> bool {
        remember_fact(&mut self.data, key, fact).unwrap_or(false)
    }

    /// Forget a fact
    pub fn forget_fact(&mut self, key: &str) -> bool {
        forget_fact(&mut self.data, key).unwrap_or(false)
    }

    /// Add a rule
    pub fn add_rule(&mut self, rule: &str) -> bool {
        let rules = self
            .data
            .as_object_mut()
            .unwrap()
            .entry("rules".to_owned())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap();
        let now = timestamp();
        let rule_text = rule.trim().chars().take(300).collect::<String>();
        if rule_text.is_empty() {
            return false;
        }
        // Check if rule already exists
        for existing in rules.iter() {
            if existing["rule"].as_str() == Some(&rule_text) {
                return false;
            }
        }
        rules.push(json!({
            "id": format!("rule_{}", Uuid::new_v4().simple()),
            "rule": rule_text,
            "category": "general",
            "enabled": true,
            "createdAt": now,
            "updatedAt": now,
            "author": "web",
        }));
        true
    }

    /// Get locations
    pub fn locations(&self) -> &Value {
        &self.data["locations"]
    }

    /// Get learned facts
    pub fn learned_facts(&self) -> &Value {
        &self.data["learnedFacts"]
    }

    /// Get rules
    pub fn rules(&self) -> &Value {
        &self.data["rules"]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_legacy_facts_and_rules_without_dropping_extended_fields() {
        let data = json!({
            "schemaVersion": 1,
            "rules": ["be kind"],
            "learnedFacts": {"home": "near the river"},
            "locations": {"home": {"x": 1, "y": 2, "z": 3, "dimension": "overworld"}},
            "customData": {"keep": true}
        });

        let normalized = normalize_memory(data).unwrap();

        assert_eq!(normalized["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(normalized["rules"][0]["rule"], "be kind");
        assert_eq!(
            normalized["learnedFacts"]["home"]["value"],
            "near the river"
        );
        assert_eq!(normalized["locations"]["home"]["dimension"], "overworld");
        assert_eq!(normalized["customData"]["keep"], true);
        assert_eq!(normalized["metadata"]["stats"]["totalLocations"], 1);
        assert_eq!(normalized["metadata"]["stats"]["totalRules"], 1);
    }

    #[test]
    fn rejects_invalid_memory_shapes_instead_of_silently_replacing_them() {
        assert!(matches!(
            normalize_memory(json!([])),
            Err(MemoryError::InvalidRoot)
        ));
        assert!(matches!(
            normalize_memory(json!({"rules": {}})),
            Err(MemoryError::InvalidField("rules"))
        ));
    }

    #[test]
    fn fact_operations_trim_inputs_and_preserve_original_creation_time() {
        let mut data = default_memory();
        assert!(remember_fact(&mut data, " base ", " river ").unwrap());
        let created_at = data["learnedFacts"]["base"]["createdAt"]
            .as_str()
            .unwrap()
            .to_owned();
        data["learnedFacts"]["base"]["category"] = json!("player");

        assert!(remember_fact(&mut data, "base", " mountain ").unwrap());
        assert_eq!(data["learnedFacts"]["base"]["value"], "mountain");
        assert_eq!(data["learnedFacts"]["base"]["createdAt"], created_at);
        assert_eq!(data["learnedFacts"]["base"]["category"], "player");
        assert!(forget_fact(&mut data, "base").unwrap());
        assert!(!forget_fact(&mut data, "base").unwrap());
        assert!(!remember_fact(&mut data, " ", "fact").unwrap());

        let long_key = "k".repeat(90);
        let long_fact = "f".repeat(510);
        assert!(remember_fact(&mut data, &long_key, &long_fact).unwrap());
        let facts = data["learnedFacts"].as_object().unwrap();
        assert_eq!(facts.keys().next().unwrap().len(), 80);
        assert_eq!(
            facts.values().next().unwrap()["value"]
                .as_str()
                .unwrap()
                .len(),
            500
        );
    }

    #[test]
    fn load_and_save_round_trip_memory_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested").join("memory.json");
        let mut data = default_memory();
        remember_fact(&mut data, "test", "value").unwrap();

        save_memory(&path, &data).unwrap();
        remember_fact(&mut data, "test", "updated").unwrap();
        save_memory(&path, &data).unwrap();
        let loaded = load_memory(&path).unwrap();

        assert_eq!(loaded["learnedFacts"]["test"]["value"], "updated");
        assert_eq!(loaded["schemaVersion"], SCHEMA_VERSION);
    }

    #[test]
    fn missing_memory_file_returns_default_data() {
        let directory = tempfile::tempdir().unwrap();
        let loaded = load_memory(directory.path().join("missing.json")).unwrap();
        assert_eq!(loaded["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(loaded["rules"], json!([]));
    }
}
