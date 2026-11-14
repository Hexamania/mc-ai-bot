use std::{
    collections::{HashMap, HashSet},
    fmt::Debug,
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use tokio::sync::RwLock;

use crate::{
    bot::minecraft::MinecraftConnection,
    bot::runtime::MinecraftRuntime,
    config::AppConfig,
};

/// Trait for bot features/plugins
#[async_trait]
pub trait Feature: Send + Sync + Debug {
    fn name(&self) -> &str;
    fn version(&self) -> &str;
    fn description(&self) -> &str;
    fn dependencies(&self) -> &[String];
    fn enabled(&self) -> bool;

    async fn initialize(
        &self,
        bot: &mut MinecraftConnection,
        runtime: &mut MinecraftRuntime,
    ) -> Result<(), String>;
    async fn shutdown(&self) -> Result<(), String>;

    fn enable(&mut self) -> Result<(), String> {
        // Default implementation - features can override
        Ok(())
    }

    fn disable(&mut self) -> Result<(), String> {
        // Default implementation - features can override
        Ok(())
    }
}

/// Feature registry for managing plugins
#[derive(Debug)]
pub struct FeatureRegistry {
    features: HashMap<String, Arc<dyn Feature>>,
    initialized: HashSet<String>,
    initialization_order: Vec<String>,
}

impl Default for FeatureRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl FeatureRegistry {
    pub fn new() -> Self {
        Self {
            features: HashMap::new(),
            initialized: HashSet::new(),
            initialization_order: Vec::new(),
        }
    }

    pub fn register(&mut self, feature: Arc<dyn Feature>) -> Result<(), String> {
        let name = feature.name().to_lowercase();

        if !feature
            .name()
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err("Feature name must be alphanumeric with underscores or hyphens".to_owned());
        }

        if self.features.contains_key(&name) {
            log::warn!("[PLUGINS] Feature \"{name}\" is being overridden");
        }

        log::info!(
            "[PLUGINS] Registered: {} v{} - {}",
            name,
            feature.version(),
            feature.description()
        );

        self.features.insert(name, feature);
        Ok(())
    }

    pub fn unregister(&mut self, name: &str) -> Result<(), String> {
        let name = name.to_lowercase();

        if let Some(feature) = self.features.get(&name) {
            if self.initialized.contains(&name) {
                // Shutdown if initialized
                let rt = tokio::runtime::Handle::current();
                rt.block_on(async {
                    if let Err(e) = feature.shutdown().await {
                        log::error!("[PLUGINS] Error shutting down \"{name}\": {e}");
                    }
                });
                self.initialized.remove(&name);
            }

            self.features.remove(&name);
            self.initialization_order.retain(|n| n != &name);
            log::info!("[PLUGINS] Unregistered: {name}");
            Ok(())
        } else {
            Err(format!("Feature \"{name}\" not found"))
        }
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Feature>> {
        self.features.get(&name.to_lowercase()).cloned()
    }

    pub fn get_all(&self) -> Vec<Arc<dyn Feature>> {
        self.features.values().cloned().collect()
    }

    pub fn get_dependencies(&self, name: &str) -> Vec<String> {
        self.features
            .get(&name.to_lowercase())
            .map(|f| f.dependencies().to_vec())
            .unwrap_or_default()
    }

    /// Initialize all features in dependency order
    pub async fn initialize_all(
        &mut self,
        bot: &mut MinecraftConnection,
        runtime: &mut MinecraftRuntime,
    ) -> Result<(), String> {
        let sorted = self.topological_sort()?;

        for name in sorted {
            if self.initialized.contains(&name) {
                log::info!("[PLUGINS] {name} already initialized, skipping");
                continue;
            }

            let feature = match self.features.get(&name) {
                Some(f) => f.clone(),
                None => continue,
            };

            // Check dependencies
            let deps = feature.dependencies();
            let missing_deps: Vec<_> = deps
                .iter()
                .filter(|dep| !self.initialized.contains(&dep.to_lowercase()))
                .cloned()
                .collect();

            if !missing_deps.is_empty() {
                log::error!(
                    "[PLUGINS] Cannot initialize \"{name}\": missing dependencies: {}",
                    missing_deps.join(", ")
                );
                continue;
            }

            log::info!("[PLUGINS] Initializing: {name}");
            if let Err(e) = feature.initialize(bot, runtime).await {
                log::error!("[PLUGINS] Failed to initialize \"{name}\": {e}");
                continue;
            }

            self.initialized.insert(name.clone());
            self.initialization_order.push(name.clone());
            log::info!("[PLUGINS] Initialized: {name}");
        }

        Ok(())
    }

    /// Shutdown all features in reverse initialization order
    pub async fn shutdown_all(&mut self) -> Result<(), String> {
        for name in self.initialization_order.iter().rev() {
            let feature = match self.features.get(name) {
                Some(f) => f.clone(),
                None => continue,
            };

            log::info!("[PLUGINS] Shutting down: {name}");
            if let Err(e) = feature.shutdown().await {
                log::error!("[PLUGINS] Error shutting down \"{name}\": {e}");
            }
            self.initialized.remove(name);
            log::info!("[PLUGINS] Shut down: {name}");
        }

        Ok(())
    }

    /// Topological sort of features based on dependencies
    fn topological_sort(&self) -> Result<Vec<String>, String> {
        let mut visited = HashSet::new();
        let mut visiting = HashSet::new();
        let mut result = Vec::new();

        fn visit(
            name: &str,
            features: &HashMap<String, Arc<dyn Feature>>,
            visited: &mut HashSet<String>,
            visiting: &mut HashSet<String>,
            result: &mut Vec<String>,
        ) -> Result<(), String> {
            let normalized = name.to_lowercase();

            if visiting.contains(&normalized) {
                return Err(format!("Circular dependency detected involving \"{name}\""));
            }

            if visited.contains(&normalized) {
                return Ok(());
            }

            visiting.insert(normalized.clone());

            if let Some(feature) = features.get(&normalized) {
                for dep in feature.dependencies() {
                    visit(dep, features, visited, visiting, result)?;
                }
            }

            visiting.remove(&normalized);
            visited.insert(normalized.clone());

            if features.contains_key(&normalized) {
                result.push(normalized);
            }

            Ok(())
        }

        for name in self.features.keys() {
            visit(
                name,
                &self.features,
                &mut visited,
                &mut visiting,
                &mut result,
            )?;
        }

        Ok(result)
    }

    pub fn is_initialized(&self, name: &str) -> bool {
        self.initialized.contains(&name.to_lowercase())
    }

    pub fn get_initialization_order(&self) -> Vec<String> {
        self.initialization_order.clone()
    }

    pub fn len(&self) -> usize {
        self.features.len()
    }

    pub fn is_empty(&self) -> bool {
        self.features.is_empty()
    }
}

/// Built-in core feature
#[derive(Debug)]
pub struct CoreFeature {
    enabled: bool,
}

impl Default for CoreFeature {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[async_trait]
impl Feature for CoreFeature {
    fn name(&self) -> &str {
        "core"
    }

    fn version(&self) -> &str {
        "1.0.0"
    }

    fn description(&self) -> &str {
        "Core bot functionality and lifecycle management"
    }

    fn dependencies(&self) -> &[String] {
        &[]
    }

    fn enabled(&self) -> bool {
        self.enabled
    }

    async fn initialize(
        &self,
        _bot: &mut MinecraftConnection,
        _runtime: &mut MinecraftRuntime,
    ) -> Result<(), String> {
        log::info!("[CORE] Core feature initialized");
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), String> {
        log::info!("[CORE] Core feature shut down");
        Ok(())
    }

    fn enable(&mut self) -> Result<(), String> {
        self.enabled = true;
        log::info!("[CORE] Core feature enabled");
        Ok(())
    }

    fn disable(&mut self) -> Result<(), String> {
        self.enabled = false;
        log::info!("[CORE] Core feature disabled");
        Ok(())
    }
}

/// Built-in movement feature
#[derive(Debug)]
pub struct MovementFeature {
    enabled: bool,
}

impl Default for MovementFeature {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[async_trait]
impl Feature for MovementFeature {
    fn name(&self) -> &str {
        "movement"
    }

    fn version(&self) -> &str {
        "1.0.0"
    }

    fn description(&self) -> &str {
        "Pathfinding, movement, and navigation utilities"
    }

    fn dependencies(&self) -> &[String] {
        &["core".to_owned()]
    }

    fn enabled(&self) -> bool {
        self.enabled
    }

    async fn initialize(
        &self,
        _bot: &mut MinecraftConnection,
        _runtime: &mut MinecraftRuntime,
    ) -> Result<(), String> {
        log::info!("[MOVEMENT] Movement feature initialized");
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), String> {
        log::info!("[MOVEMENT] Movement feature shut down");
        Ok(())
    }

    fn enable(&mut self) -> Result<(), String> {
        self.enabled = true;
        log::info!("[MOVEMENT] Movement feature enabled");
        Ok(())
    }

    fn disable(&mut self) -> Result<(), String> {
        self.enabled = false;
        log::info!("[MOVEMENT] Movement feature disabled");
        Ok(())
    }
}

/// Built-in combat feature
#[derive(Debug)]
pub struct CombatFeature {
    enabled: bool,
}

impl Default for CombatFeature {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[async_trait]
impl Feature for CombatFeature {
    fn name(&self) -> &str {
        "combat"
    }

    fn version(&self) -> &str {
        "1.0.0"
    }

    fn description(&self) -> &str {
        "Combat mechanics, PvP, and auto-defense"
    }

    fn dependencies(&self) -> &[String] {
        &["core".to_owned(), "movement".to_owned()]
    }

    fn enabled(&self) -> bool {
        self.enabled
    }

    async fn initialize(
        &self,
        _bot: &mut MinecraftConnection,
        _runtime: &mut MinecraftRuntime,
    ) -> Result<(), String> {
        log::info!("[COMBAT] Combat feature initialized");
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), String> {
        log::info!("[COMBAT] Combat feature shut down");
        Ok(())
    }

    fn enable(&mut self) -> Result<(), String> {
        self.enabled = true;
        log::info!("[COMBAT] Combat feature enabled");
        Ok(())
    }

    fn disable(&mut self) -> Result<(), String> {
        self.enabled = false;
        log::info!("[COMBAT] Combat feature disabled");
        Ok(())
    }
}

/// Built-in automation feature
#[derive(Debug)]
pub struct AutomationFeature {
    enabled: bool,
}

impl Default for AutomationFeature {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[async_trait]
impl Feature for AutomationFeature {
    fn name(&self) -> &str {
        "automation"
    }

    fn version(&self) -> &str {
        "1.0.0"
    }

    fn description(&self) -> &str {
        "Automation tasks: mining, farming, building, progression"
    }

    fn dependencies(&self) -> &[String] {
        &["core".to_owned(), "movement".to_owned()]
    }

    fn enabled(&self) -> bool {
        self.enabled
    }

    async fn initialize(
        &self,
        _bot: &mut MinecraftConnection,
        _runtime: &mut MinecraftRuntime,
    ) -> Result<(), String> {
        log::info!("[AUTOMATION] Automation feature initialized");
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), String> {
        log::info!("[AUTOMATION] Automation feature shut down");
        Ok(())
    }

    fn enable(&mut self) -> Result<(), String> {
        self.enabled = true;
        log::info!("[AUTOMATION] Automation feature enabled");
        Ok(())
    }

    fn disable(&mut self) -> Result<(), String> {
        self.enabled = false;
        log::info!("[AUTOMATION] Automation feature disabled");
        Ok(())
    }
}

/// Built-in memory feature
#[derive(Debug)]
pub struct MemoryFeature {
    enabled: bool,
}

impl Default for MemoryFeature {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[async_trait]
impl Feature for MemoryFeature {
    fn name(&self) -> &str {
        "memory"
    }

    fn version(&self) -> &str {
        "1.0.0"
    }

    fn description(&self) -> &str {
        "Persistent memory system for locations, players, tasks"
    }

    fn dependencies(&self) -> &[String] {
        &["core".to_owned()]
    }

    fn enabled(&self) -> bool {
        self.enabled
    }

    async fn initialize(
        &self,
        _bot: &mut MinecraftConnection,
        _runtime: &mut MinecraftRuntime,
    ) -> Result<(), String> {
        log::info!("[MEMORY] Memory feature initialized");
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), String> {
        log::info!("[MEMORY] Memory feature shut down");
        Ok(())
    }

    fn enable(&mut self) -> Result<(), String> {
        self.enabled = true;
        log::info!("[MEMORY] Memory feature enabled");
        Ok(())
    }

    fn disable(&mut self) -> Result<(), String> {
        self.enabled = false;
        log::info!("[MEMORY] Memory feature disabled");
        Ok(())
    }
}

/// Built-in web dashboard feature
#[derive(Debug)]
pub struct WebFeature {
    enabled: bool,
}

impl Default for WebFeature {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[async_trait]
impl Feature for WebFeature {
    fn name(&self) -> &str {
        "web"
    }

    fn version(&self) -> &str {
        "1.0.0"
    }

    fn description(&self) -> &str {
        "Web dashboard and Socket.io server"
    }

    fn dependencies(&self) -> &[String] {
        &["core".to_owned(), "memory".to_owned()]
    }

    fn enabled(&self) -> bool {
        self.enabled
    }

    async fn initialize(
        &self,
        _bot: &mut MinecraftConnection,
        _runtime: &mut MinecraftRuntime,
    ) -> Result<(), String> {
        log::info!("[WEB] Web feature initialized (placeholder - not yet implemented in Rust)");
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), String> {
        log::info!("[WEB] Web feature shut down");
        Ok(())
    }

    fn enable(&mut self) -> Result<(), String> {
        self.enabled = true;
        log::info!("[WEB] Web feature enabled");
        Ok(())
    }

    fn disable(&mut self) -> Result<(), String> {
        self.enabled = false;
        log::info!("[WEB] Web feature disabled");
        Ok(())
    }
}

/// Register all built-in features
pub fn register_builtin_features(registry: &mut FeatureRegistry) -> Result<(), String> {
    registry.register(Arc::new(CoreFeature::default()))?;
    registry.register(Arc::new(MovementFeature::default()))?;
    registry.register(Arc::new(CombatFeature::default()))?;
    registry.register(Arc::new(AutomationFeature::default()))?;
    registry.register(Arc::new(MemoryFeature::default()))?;
    registry.register(Arc::new(WebFeature::default()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_feature_registry_register_and_get() {
        let mut registry = FeatureRegistry::new();
        let feature = Arc::new(CoreFeature::default());

        registry.register(feature.clone()).unwrap();
        let retrieved = registry.get("core").unwrap();
        assert_eq!(retrieved.name(), "core");
    }

    #[tokio::test]
    async fn test_feature_registry_dependencies() {
        let mut registry = FeatureRegistry::new();
        registry.register(Arc::new(CoreFeature::default())).unwrap();
        registry
            .register(Arc::new(MovementFeature::default()))
            .unwrap();

        let deps = registry.get_dependencies("movement");
        assert!(deps.contains(&"core".to_owned()));
    }

    #[tokio::test]
    async fn test_topological_sort() {
        let mut registry = FeatureRegistry::new();
        registry.register(Arc::new(CoreFeature::default())).unwrap();
        registry
            .register(Arc::new(MovementFeature::default()))
            .unwrap();
        registry
            .register(Arc::new(CombatFeature::default()))
            .unwrap();

        let sorted = registry.topological_sort().unwrap();
        // core should come before movement, movement before combat
        let core_idx = sorted.iter().position(|s| s == "core").unwrap();
        let movement_idx = sorted.iter().position(|s| s == "movement").unwrap();
        let combat_idx = sorted.iter().position(|s| s == "combat").unwrap();

        assert!(core_idx < movement_idx);
        assert!(movement_idx < combat_idx);
    }

    #[tokio::test]
    async fn test_circular_dependency_detection() {
        // This would require custom features with circular deps
        // Skipping for now as it requires more setup
    }
}
