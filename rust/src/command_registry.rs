use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    future::Future,
    pin::Pin,
    sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard},
    time::{Duration, Instant, SystemTime},
};

use serde_json::Value;
use thiserror::Error;

use crate::{
    arguments::{
        ArgumentContext, ArgumentDefinition, ArgumentParser, ArgumentType, ArgumentValue,
        OptionDefinition, ParsedArguments,
    },
    commands::{PermissionConfig, PermissionLevel},
};

pub type CommandFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;
pub type CommandHandler =
    Arc<dyn for<'a> Fn(&'a CommandContext, &'a CommandRegistry) -> CommandFuture<'a> + Send + Sync>;
pub type CommandValidator =
    Arc<dyn for<'a> Fn(&'a CommandContext) -> CommandFuture<'a> + Send + Sync>;
pub type CommandCompletion =
    Arc<dyn for<'a> Fn(&'a CommandContext, Option<&'a str>) -> CommandFuture<'a> + Send + Sync>;

#[derive(Clone)]
pub struct CommandDefinition {
    pub name: String,
    pub aliases: Vec<String>,
    pub description: String,
    pub usage: Option<String>,
    pub short_description: Option<String>,
    pub category: Option<String>,
    pub permission: Option<PermissionConfig>,
    pub arguments: Vec<ArgumentDefinition>,
    pub options: Vec<OptionDefinition>,
    pub examples: Vec<String>,
    pub hidden: bool,
    pub deprecated: bool,
    pub deprecation_message: Option<String>,
    pub cooldown: Option<Duration>,
    pub max_uses: Option<u32>,
    pub execute: CommandHandler,
    pub validate: Option<CommandValidator>,
    pub on_complete: Option<CommandCompletion>,
}

impl CommandDefinition {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        execute: CommandHandler,
    ) -> Self {
        Self {
            name: name.into(),
            aliases: Vec::new(),
            description: description.into(),
            usage: None,
            short_description: None,
            category: None,
            permission: None,
            arguments: Vec::new(),
            options: Vec::new(),
            examples: Vec::new(),
            hidden: false,
            deprecated: false,
            deprecation_message: None,
            cooldown: None,
            max_uses: None,
            execute,
            validate: None,
            on_complete: None,
        }
    }
}

pub struct CommandContext {
    pub username: String,
    pub args: ParsedArguments,
    pub raw_args: Vec<String>,
    pub is_admin: bool,
    pub is_trusted: bool,
    pub is_private_message: bool,
    pub has_permission: bool,
    pub permission_level: PermissionLevel,
    pub command_name: String,
    pub full_command: String,
    pub timestamp: SystemTime,
    pub metadata: BTreeMap<String, Value>,
    pub argument_context: ArgumentContext,
    reply_handler: Arc<dyn Fn(&str) + Send + Sync>,
    private_reply_handler: Arc<dyn Fn(&str) + Send + Sync>,
}

impl CommandContext {
    pub fn new(
        username: impl Into<String>,
        raw_args: Vec<String>,
        permission_level: PermissionLevel,
        is_private_message: bool,
        reply: impl Fn(&str) + Send + Sync + 'static,
        private_reply: impl Fn(&str) + Send + Sync + 'static,
    ) -> Self {
        let username = username.into();
        let is_admin = permission_level == PermissionLevel::Admin;
        let is_trusted = permission_level >= PermissionLevel::Trusted;
        Self {
            username,
            args: ParsedArguments {
                raw: raw_args.clone(),
                ..ParsedArguments::default()
            },
            raw_args,
            is_admin,
            is_trusted,
            is_private_message,
            has_permission: false,
            permission_level,
            command_name: String::new(),
            full_command: String::new(),
            timestamp: SystemTime::now(),
            metadata: BTreeMap::new(),
            argument_context: ArgumentContext::default(),
            reply_handler: Arc::new(reply),
            private_reply_handler: Arc::new(private_reply),
        }
    }

    pub fn with_argument_context(mut self, context: ArgumentContext) -> Self {
        self.argument_context = context;
        self
    }

    pub fn reply(&self, message: &str) {
        (self.reply_handler)(message);
    }

    pub fn private_reply(&self, message: &str) {
        (self.private_reply_handler)(message);
    }

    pub fn error(&self, message: &str) {
        self.private_reply(message);
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommandResult {
    pub success: bool,
    pub found: bool,
    pub error: Option<String>,
    pub execution_time_ms: Option<u128>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CommandStats {
    pub name: String,
    pub total_executions: u64,
    pub successful_executions: u64,
    pub failed_executions: u64,
    pub average_execution_time_ms: f64,
    pub last_executed: Option<SystemTime>,
    pub most_common_error: Option<String>,
}

impl CommandStats {
    fn new(name: String) -> Self {
        Self {
            name,
            total_executions: 0,
            successful_executions: 0,
            failed_executions: 0,
            average_execution_time_ms: 0.0,
            last_executed: None,
            most_common_error: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistrationWarning(pub String);

#[derive(Clone, Debug, Error, PartialEq, Eq, serde::Serialize)]
pub enum CommandRegistryError {
    #[error("Command registry lock was poisoned")]
    LockPoisoned,
    #[error("Command name cannot be empty")]
    EmptyCommandName,
}

#[derive(Default)]
struct RegistryState {
    commands: HashMap<String, CommandDefinition>,
    command_order: Vec<String>,
    aliases: BTreeMap<String, String>,
    categories: BTreeSet<String>,
    cooldowns: HashMap<(String, String), CooldownEntry>,
    stats: HashMap<String, CommandStats>,
    prefix: String,
    admin_prefix: String,
}

#[derive(Clone, Copy)]
struct CooldownEntry {
    window_start: Instant,
    uses: u32,
}

#[derive(Clone)]
pub struct CommandRegistry {
    state: Arc<RwLock<RegistryState>>,
}

impl Default for CommandRegistry {
    fn default() -> Self {
        Self::new("!", "$")
    }
}

impl CommandRegistry {
    pub fn new(prefix: impl Into<String>, admin_prefix: impl Into<String>) -> Self {
        let mut state = RegistryState::default();
        state.prefix = prefix.into();
        state.admin_prefix = admin_prefix.into();
        Self {
            state: Arc::new(RwLock::new(state)),
        }
    }

    pub fn register(
        &self,
        mut command: CommandDefinition,
    ) -> Result<Vec<RegistrationWarning>, CommandRegistryError> {
        let name = command.name.to_lowercase();
        if name.trim().is_empty() {
            return Err(CommandRegistryError::EmptyCommandName);
        }
        command.name = name.clone();
        let category = command
            .category
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("General")
            .to_owned();
        command.category = Some(category);
        command.aliases = command
            .aliases
            .into_iter()
            .map(|alias| alias.to_lowercase())
            .collect();

        let mut state = self.write()?;
        let mut warnings = Vec::new();
        if state.commands.contains_key(&name) {
            warnings.push(RegistrationWarning(format!(
                "Command \"{name}\" overrides an existing command"
            )));
        }

        state.aliases.retain(|_, target| target != &name);
        if state.aliases.remove(&name).is_some() {
            warnings.push(RegistrationWarning(format!(
                "Command \"{name}\" replaced an alias with the same name"
            )));
        }

        if !state.commands.contains_key(&name) {
            state.command_order.push(name.clone());
        }
        state
            .stats
            .insert(name.clone(), CommandStats::new(name.clone()));
        state.commands.insert(name.clone(), command.clone());

        for alias in &command.aliases {
            if state.commands.contains_key(alias) || state.aliases.contains_key(alias) {
                warnings.push(RegistrationWarning(format!(
                    "Alias \"{alias}\" conflicts with an existing command or alias"
                )));
            } else {
                state.aliases.insert(alias.clone(), name.clone());
            }
        }
        refresh_categories(&mut state);
        Ok(warnings)
    }

    pub fn unregister(&self, name: &str) -> Result<bool, CommandRegistryError> {
        let name = name.to_lowercase();
        let mut state = self.write()?;
        if state.commands.remove(&name).is_none() {
            return Ok(false);
        }
        state.command_order.retain(|command| command != &name);
        state.aliases.retain(|_, target| target != &name);
        state.stats.remove(&name);
        state
            .cooldowns
            .retain(|(command_name, _), _| command_name != &name);
        refresh_categories(&mut state);
        Ok(true)
    }

    pub fn get(&self, name: &str) -> Result<Option<CommandDefinition>, CommandRegistryError> {
        let name = name.to_lowercase();
        let state = self.read()?;
        let command_name = if state.commands.contains_key(&name) {
            Some(name.clone())
        } else {
            state.aliases.get(&name).cloned()
        };
        Ok(command_name.and_then(|command_name| state.commands.get(&command_name).cloned()))
    }

    pub fn get_all(&self) -> Result<Vec<CommandDefinition>, CommandRegistryError> {
        let state = self.read()?;
        Ok(state
            .command_order
            .iter()
            .filter_map(|name| state.commands.get(name).cloned())
            .collect())
    }

    pub fn get_by_category(
        &self,
        category: &str,
    ) -> Result<Vec<CommandDefinition>, CommandRegistryError> {
        Ok(self
            .get_all()?
            .into_iter()
            .filter(|command| command.category.as_deref() == Some(category))
            .collect())
    }

    pub fn has(&self, name: &str) -> Result<bool, CommandRegistryError> {
        Ok(self.get(name)?.is_some())
    }

    pub fn get_command_names(&self) -> Result<Vec<String>, CommandRegistryError> {
        let mut names = self.read()?.commands.keys().cloned().collect::<Vec<_>>();
        names.sort();
        Ok(names)
    }

    pub fn get_aliases(&self) -> Result<BTreeMap<String, String>, CommandRegistryError> {
        Ok(self.read()?.aliases.clone())
    }

    pub fn get_categories(&self) -> Result<Vec<String>, CommandRegistryError> {
        Ok(self.read()?.categories.iter().cloned().collect())
    }

    pub fn get_help(
        &self,
        name: &str,
        prefix: &str,
    ) -> Result<Option<String>, CommandRegistryError> {
        let Some(command) = self.get(name)? else {
            return Ok(None);
        };
        let mut help = format!("\n📋 **{}**", command.name);
        if !command.description.is_empty() {
            help.push_str(&format!("\n{}", command.description));
        }
        if let Some(usage) = &command.usage {
            help.push_str(&format!("\nUsage: {prefix}{} {usage}", command.name));
        }
        if !command.aliases.is_empty() {
            help.push_str(&format!("\nAliases: {}", command.aliases.join(", ")));
        }
        if !command.examples.is_empty() {
            help.push_str("\nExamples:");
            for example in &command.examples {
                help.push_str(&format!("\n  {prefix}{example}"));
            }
        }
        if let Some(permission) = &command.permission {
            if permission.level != PermissionLevel::Guest {
                help.push_str(&format!(
                    "\n⚠️ Requires: {}",
                    permission_level_name(permission.level)
                ));
            }
            if permission.pm_only {
                help.push_str("\n📩 PM only");
            }
            if permission.public_only {
                help.push_str("\n💬 Public only");
            }
        }
        if let Some(cooldown) = command.cooldown.filter(|value| !value.is_zero()) {
            help.push_str(&format!("\n⏱️ Cooldown: {}s", cooldown.as_secs_f64()));
        }
        Ok(Some(help))
    }

    pub fn get_full_help(
        &self,
        prefix: &str,
        user_level: PermissionLevel,
    ) -> Result<String, CommandRegistryError> {
        let commands = self.get_all()?;
        let accessible = commands
            .into_iter()
            .filter(|command| {
                !command.hidden
                    && command
                        .permission
                        .as_ref()
                        .map(|permission| permission.level)
                        .unwrap_or_default()
                        <= user_level
            })
            .collect::<Vec<_>>();
        let mut categories = BTreeMap::<String, Vec<CommandDefinition>>::new();
        for command in accessible {
            categories
                .entry(
                    command
                        .category
                        .clone()
                        .unwrap_or_else(|| "General".to_owned()),
                )
                .or_default()
                .push(command);
        }

        let mut output = format!("📋 **Available Commands** (Prefix: `{prefix}`)\n\n");
        for (category, commands) in categories {
            output.push_str(&format!("**{category}:**\n"));
            let lines = commands
                .iter()
                .map(|command| {
                    let mut line = format!("`{}{}`", prefix, command.name);
                    if let Some(description) = &command.short_description {
                        line.push_str(&format!(" - {description}"));
                    }
                    line
                })
                .collect::<Vec<_>>()
                .join("\n");
            output.push_str(&lines);
            output.push_str("\n\n");
        }
        output.push_str(&format!(
            "Use `{prefix}help <command>` for details on a specific command."
        ));
        Ok(output)
    }

    pub fn register_help_command(
        &self,
        prefix: impl Into<String>,
    ) -> Result<Vec<RegistrationWarning>, CommandRegistryError> {
        let prefix = prefix.into();
        let mut command = CommandDefinition::new(
            "help",
            "Show available commands",
            Arc::new(move |context, registry| {
                let prefix = prefix.clone();
                Box::pin(async move {
                    if let Some(requested) = context.args.args.first() {
                        let requested = display_argument_value(requested);
                        match registry.get_help(&requested, &prefix) {
                            Ok(Some(help)) => context.private_reply(&help),
                            Ok(None) => context
                                .private_reply(&format!("❌ Command \"{requested}\" not found.")),
                            Err(error) => return Err(error.to_string()),
                        }
                    } else {
                        match registry.get_full_help(&prefix, context.permission_level) {
                            Ok(help) => context.private_reply(&help),
                            Err(error) => return Err(error.to_string()),
                        }
                    }
                    Ok(())
                })
            }),
        );
        command.aliases = vec!["h".to_owned(), "commands".to_owned(), "cmds".to_owned()];
        command.usage = Some("[command]".to_owned());
        command.short_description =
            Some("Show command list or get help for a specific command".to_owned());
        command.category = Some("General".to_owned());
        command.permission = Some(PermissionConfig::default());
        command.arguments.push(ArgumentDefinition::new(
            "command",
            ArgumentType::String,
            false,
        ));
        command.examples = vec![
            "help".to_owned(),
            "help ping".to_owned(),
            "help follow".to_owned(),
        ];
        self.register(command)
    }

    pub fn register_ping_command(&self) -> Result<Vec<RegistrationWarning>, CommandRegistryError> {
        let mut command = CommandDefinition::new(
            "ping",
            "Check bot responsiveness",
            Arc::new(|context, _| {
                Box::pin(async move {
                    context.reply("🏓 Pong!");
                    Ok(())
                })
            }),
        );
        command.short_description = Some("Check if bot is responsive".to_owned());
        command.category = Some("General".to_owned());
        command.permission = Some(PermissionConfig::default());
        self.register(command)
    }

    pub async fn execute(
        &self,
        name: &str,
        context: &mut CommandContext,
    ) -> Result<CommandResult, CommandRegistryError> {
        let started = Instant::now();
        let Some(command) = self.get(name)? else {
            return Ok(CommandResult {
                success: false,
                found: false,
                error: Some(format!("Command \"{name}\" not found")),
                execution_time_ms: Some(started.elapsed().as_millis()),
            });
        };

        if command.deprecated {
            let message = command
                .deprecation_message
                .as_deref()
                .unwrap_or("This command is deprecated.");
            context.error(&format!("⚠️ {message}"));
        }

        if let Err(message) = check_permission(&command, context) {
            context.has_permission = false;
            context.error(&message);
            return Ok(failed_result(true, message, started.elapsed()));
        }
        context.has_permission = true;

        if let Some(remaining) = self.check_cooldown(&command, context, Instant::now())? {
            let message = format!(
                "⏳ Command on cooldown. Try again in {}s.",
                remaining.as_secs_f64().ceil() as u64
            );
            context.error(&message);
            return Ok(failed_result(
                true,
                "Command on cooldown".to_owned(),
                started.elapsed(),
            ));
        }

        context.command_name = command.name.clone();
        if context.full_command.is_empty() {
            let prefix = self.get_prefix()?;
            context.full_command =
                format!("{prefix}{} {}", command.name, context.raw_args.join(" "))
                    .trim()
                    .to_owned();
        }
        let parser = ArgumentParser::new(context.argument_context.clone());
        context.args = match parser.parse(&context.raw_args, &command.arguments, &command.options) {
            Ok(parsed) => parsed,
            Err(error) => {
                let message = error.to_string();
                context.error(&format!("❌ {message}"));
                return Ok(failed_result(true, message, started.elapsed()));
            }
        };
        let validation =
            ArgumentParser::validate(&context.args, &command.arguments, &command.options);
        if !validation.valid {
            let message = validation.errors.join("; ");
            context.error(&format!("❌ {message}"));
            return Ok(failed_result(true, message, started.elapsed()));
        }

        if let Some(validate) = &command.validate {
            if let Err(message) = validate(context).await {
                context.error(&format!("❌ {message}"));
                return Ok(failed_result(true, message, started.elapsed()));
            }
        }
        self.update_cooldown(&command, context, Instant::now())?;

        let mut execution_error = (command.execute)(context, self).await.err();
        let mut completion_error = None;
        if let Some(on_complete) = &command.on_complete {
            if let Err(error) = on_complete(context, execution_error.as_deref()).await {
                completion_error = Some(error);
            }
        }
        let error = match (execution_error.take(), completion_error) {
            (Some(execution), Some(completion)) => Some(format!(
                "{execution}; completion callback failed: {completion}"
            )),
            (Some(execution), None) => Some(execution),
            (None, Some(completion)) => Some(format!("Completion callback failed: {completion}")),
            (None, None) => None,
        };
        let success = error.is_none();
        let elapsed = started.elapsed();
        self.update_stats(&command.name, elapsed, success, error.as_deref())?;
        if let Some(error) = &error {
            context.error(&format!("❌ Command error: {error}"));
        }

        Ok(CommandResult {
            success,
            found: true,
            error,
            execution_time_ms: Some(elapsed.as_millis()),
        })
    }

    pub fn get_stats(
        &self,
        command_name: Option<&str>,
    ) -> Result<Vec<CommandStats>, CommandRegistryError> {
        let state = self.read()?;
        if let Some(name) = command_name {
            return Ok(state
                .stats
                .get(&name.to_lowercase())
                .cloned()
                .into_iter()
                .collect());
        }
        let mut stats = state.stats.values().cloned().collect::<Vec<_>>();
        stats.sort_by(|left, right| {
            right
                .total_executions
                .cmp(&left.total_executions)
                .then_with(|| left.name.cmp(&right.name))
        });
        Ok(stats)
    }

    pub fn clear_cooldown(
        &self,
        command_name: &str,
        username: &str,
    ) -> Result<(), CommandRegistryError> {
        self.write()?
            .cooldowns
            .remove(&cooldown_key(command_name, username));
        Ok(())
    }

    pub fn clear_all_cooldowns(&self) -> Result<(), CommandRegistryError> {
        self.write()?.cooldowns.clear();
        Ok(())
    }

    pub fn set_prefix(&self, prefix: impl Into<String>) -> Result<(), CommandRegistryError> {
        self.write()?.prefix = prefix.into();
        Ok(())
    }

    pub fn set_admin_prefix(&self, prefix: impl Into<String>) -> Result<(), CommandRegistryError> {
        self.write()?.admin_prefix = prefix.into();
        Ok(())
    }

    pub fn get_prefix(&self) -> Result<String, CommandRegistryError> {
        Ok(self.read()?.prefix.clone())
    }

    pub fn get_admin_prefix(&self) -> Result<String, CommandRegistryError> {
        Ok(self.read()?.admin_prefix.clone())
    }

    fn check_cooldown(
        &self,
        command: &CommandDefinition,
        context: &CommandContext,
        now: Instant,
    ) -> Result<Option<Duration>, CommandRegistryError> {
        let Some(cooldown) = command.cooldown.filter(|value| !value.is_zero()) else {
            return Ok(None);
        };
        let state = self.read()?;
        let Some(entry) = state
            .cooldowns
            .get(&cooldown_key(&command.name, &context.username))
        else {
            return Ok(None);
        };
        if now.duration_since(entry.window_start) >= cooldown {
            return Ok(None);
        }
        if command
            .max_uses
            .is_some_and(|max_uses| entry.uses >= max_uses)
        {
            return Ok(Some(
                cooldown.saturating_sub(now.duration_since(entry.window_start)),
            ));
        }
        Ok(None)
    }

    fn update_cooldown(
        &self,
        command: &CommandDefinition,
        context: &CommandContext,
        now: Instant,
    ) -> Result<(), CommandRegistryError> {
        let Some(cooldown) = command.cooldown.filter(|value| !value.is_zero()) else {
            return Ok(());
        };
        let mut state = self.write()?;
        let key = cooldown_key(&command.name, &context.username);
        match state.cooldowns.get_mut(&key) {
            Some(entry) if now.duration_since(entry.window_start) < cooldown => {
                entry.uses = entry.uses.saturating_add(1);
            }
            _ => {
                state.cooldowns.insert(
                    key,
                    CooldownEntry {
                        window_start: now,
                        uses: 1,
                    },
                );
            }
        }
        Ok(())
    }

    fn update_stats(
        &self,
        command_name: &str,
        execution_time: Duration,
        success: bool,
        error: Option<&str>,
    ) -> Result<(), CommandRegistryError> {
        let mut state = self.write()?;
        let Some(stats) = state.stats.get_mut(command_name) else {
            return Ok(());
        };
        stats.total_executions += 1;
        stats.last_executed = Some(SystemTime::now());
        if success {
            stats.successful_executions += 1;
        } else {
            stats.failed_executions += 1;
            stats.most_common_error = error.map(str::to_owned);
        }
        let elapsed_ms = execution_time.as_secs_f64() * 1000.0;
        stats.average_execution_time_ms = stats.average_execution_time_ms * 0.9 + elapsed_ms * 0.1;
        Ok(())
    }

    fn read(&self) -> Result<RwLockReadGuard<'_, RegistryState>, CommandRegistryError> {
        self.state
            .read()
            .map_err(|_| CommandRegistryError::LockPoisoned)
    }

    fn write(&self) -> Result<RwLockWriteGuard<'_, RegistryState>, CommandRegistryError> {
        self.state
            .write()
            .map_err(|_| CommandRegistryError::LockPoisoned)
    }
}

fn refresh_categories(state: &mut RegistryState) {
    state.categories = state
        .commands
        .values()
        .filter_map(|command| command.category.clone())
        .collect();
}

fn check_permission(command: &CommandDefinition, context: &CommandContext) -> Result<(), String> {
    let Some(permission) = &command.permission else {
        return Ok(());
    };
    if permission.denied_users.iter().any(|username| {
        username
            .trim()
            .eq_ignore_ascii_case(context.username.trim())
    }) {
        return Err("❌ You are not allowed to use this command.".to_owned());
    }
    if permission.allowed_users.iter().any(|username| {
        username
            .trim()
            .eq_ignore_ascii_case(context.username.trim())
    }) {
        return Ok(());
    }
    if permission.pm_only && !context.is_private_message {
        return Err("❌ This command can only be used in private messages.".to_owned());
    }
    if permission.public_only && context.is_private_message {
        return Err("❌ This command can only be used in public chat.".to_owned());
    }
    if context.permission_level < permission.level {
        return Err(format!(
            "❌ Access denied. This command requires {} permission.",
            permission_level_name(permission.level)
        ));
    }
    Ok(())
}

fn permission_level_name(level: PermissionLevel) -> &'static str {
    match level {
        PermissionLevel::Guest => "guest",
        PermissionLevel::Trusted => "trusted",
        PermissionLevel::Admin => "admin",
    }
}

fn cooldown_key(command_name: &str, username: &str) -> (String, String) {
    (
        command_name.to_lowercase(),
        username.trim().to_ascii_lowercase(),
    )
}

fn failed_result(found: bool, error: String, elapsed: Duration) -> CommandResult {
    CommandResult {
        success: false,
        found,
        error: Some(error),
        execution_time_ms: Some(elapsed.as_millis()),
    }
}

fn display_argument_value(value: &ArgumentValue) -> String {
    match value {
        ArgumentValue::String(value)
        | ArgumentValue::Player(value)
        | ArgumentValue::Item(value) => value.clone(),
        ArgumentValue::Number(value) => value.to_string(),
        ArgumentValue::Boolean(value) => value.to_string(),
        ArgumentValue::Position(position) => {
            format!("{} {} {}", position.x, position.y, position.z)
        }
        ArgumentValue::List(values) => values
            .iter()
            .map(display_argument_value)
            .collect::<Vec<_>>()
            .join(" "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        sync::{Mutex, MutexGuard},
        task::{Context as TaskContext, Poll, Wake, Waker},
    };

    struct NoopWake;

    impl Wake for NoopWake {
        fn wake(self: Arc<Self>) {}
    }

    fn handler(
        callback: impl Fn(&CommandContext) -> Result<(), String> + Send + Sync + 'static,
    ) -> CommandHandler {
        let callback = Arc::new(callback);
        Arc::new(move |context, _| {
            let callback = Arc::clone(&callback);
            Box::pin(async move { callback(context) })
        })
    }

    fn context(
        username: &str,
        role: PermissionLevel,
        private: bool,
        raw_args: &[&str],
        replies: Arc<Mutex<Vec<String>>>,
    ) -> CommandContext {
        let public_replies = Arc::clone(&replies);
        CommandContext::new(
            username,
            raw_args.iter().map(|value| (*value).to_owned()).collect(),
            role,
            private,
            move |message| lock(&public_replies).push(message.to_owned()),
            move |message| lock(&replies).push(message.to_owned()),
        )
    }

    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().expect("test mutex should not be poisoned")
    }

    fn run<F: Future>(future: F) -> F::Output {
        let waker = Waker::from(Arc::new(NoopWake));
        let mut task_context = TaskContext::from_waker(&waker);
        let mut future = Box::pin(future);
        loop {
            match future.as_mut().poll(&mut task_context) {
                Poll::Ready(value) => return value,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    #[test]
    fn registers_aliases_categories_and_replaces_commands_cleanly() {
        let registry = CommandRegistry::default();
        let mut command = CommandDefinition::new("Ping", "original", handler(|_| Ok(())));
        command.aliases = vec!["p".to_owned()];
        command.category = Some("General".to_owned());
        registry.register(command).unwrap();
        assert!(registry.has("P").unwrap());
        assert_eq!(registry.get_command_names().unwrap(), ["ping"]);

        let mut replacement = CommandDefinition::new("ping", "replacement", handler(|_| Ok(())));
        replacement.aliases = vec!["pong".to_owned()];
        let warnings = registry.register(replacement).unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(registry.get("p").unwrap().is_none());
        assert_eq!(
            registry.get("pong").unwrap().unwrap().description,
            "replacement"
        );
        assert_eq!(registry.get_categories().unwrap(), ["General"]);
        assert!(registry.unregister("PING").unwrap());
        assert!(!registry.has("pong").unwrap());
        assert!(registry.get_categories().unwrap().is_empty());
    }

    #[test]
    fn parses_arguments_and_executes_handlers_through_aliases() {
        let registry = CommandRegistry::default();
        let output = Arc::new(Mutex::new(Vec::new()));
        let mut command = CommandDefinition::new(
            "count",
            "Count input",
            Arc::new(|context, _| {
                Box::pin(async move {
                    let ArgumentValue::Number(value) = &context.args.args[0] else {
                        return Err("Expected parsed number".to_owned());
                    };
                    context.reply(&format!("count={value}"));
                    Ok(())
                })
            }),
        );
        command.aliases.push("c".to_owned());
        command
            .arguments
            .push(ArgumentDefinition::new("value", ArgumentType::Number, true));
        registry.register(command).unwrap();

        let mut context = context(
            "Alex",
            PermissionLevel::Guest,
            false,
            &["42"],
            output.clone(),
        );
        let result = run(registry.execute("C", &mut context)).unwrap();
        assert!(result.success);
        assert_eq!(*lock(&output), vec!["count=42".to_owned()]);
        assert_eq!(context.command_name, "count");
        assert_eq!(context.args.args, vec![ArgumentValue::Number(42.0)]);
        assert_eq!(
            registry.get_stats(Some("count")).unwrap()[0].total_executions,
            1
        );
    }

    #[test]
    fn enforces_permission_order_and_reports_unknown_commands() {
        let registry = CommandRegistry::default();
        let mut command = CommandDefinition::new("private", "Restricted", handler(|_| Ok(())));
        command.permission = Some(PermissionConfig {
            level: PermissionLevel::Admin,
            denied_users: vec!["blocked".to_owned()],
            allowed_users: vec!["alex".to_owned()],
            pm_only: true,
            public_only: false,
        });
        registry.register(command).unwrap();

        let replies = Arc::new(Mutex::new(Vec::new()));
        let mut blocked = context(
            "Blocked",
            PermissionLevel::Admin,
            true,
            &[],
            replies.clone(),
        );
        let result = run(registry.execute("private", &mut blocked)).unwrap();
        assert!(!result.success);
        assert_eq!(
            result.error.as_deref(),
            Some("❌ You are not allowed to use this command.")
        );

        let mut allowed = context("Alex", PermissionLevel::Guest, false, &[], replies.clone());
        assert!(
            run(registry.execute("private", &mut allowed))
                .unwrap()
                .success
        );

        let mut unknown = context("Alex", PermissionLevel::Guest, false, &[], replies);
        let result = run(registry.execute("missing", &mut unknown)).unwrap();
        assert!(!result.found);
    }

    #[test]
    fn enforces_cooldown_limits_and_supports_explicit_clear() {
        let registry = CommandRegistry::default();
        let mut command = CommandDefinition::new("limited", "Limited", handler(|_| Ok(())));
        command.cooldown = Some(Duration::from_secs(30));
        command.max_uses = Some(1);
        registry.register(command).unwrap();
        let replies = Arc::new(Mutex::new(Vec::new()));

        let mut first = context("Alex", PermissionLevel::Guest, false, &[], replies.clone());
        assert!(
            run(registry.execute("limited", &mut first))
                .unwrap()
                .success
        );
        let mut second = context("aLeX", PermissionLevel::Guest, false, &[], replies.clone());
        let result = run(registry.execute("limited", &mut second)).unwrap();
        assert_eq!(result.error.as_deref(), Some("Command on cooldown"));
        assert!(!lock(&replies).is_empty());

        registry.clear_cooldown("LIMITED", "alex").unwrap();
        let mut third = context("Alex", PermissionLevel::Guest, false, &[], replies);
        assert!(
            run(registry.execute("limited", &mut third))
                .unwrap()
                .success
        );
    }

    #[test]
    fn records_failures_and_runs_completion_callbacks_once() {
        let registry = CommandRegistry::default();
        let completed = Arc::new(Mutex::new(Vec::new()));
        let mut command =
            CommandDefinition::new("broken", "Fails", handler(|_| Err("failed".to_owned())));
        let completed_callback = Arc::clone(&completed);
        command.on_complete = Some(Arc::new(move |_, error| {
            let completed_callback = Arc::clone(&completed_callback);
            let error = error.map(str::to_owned);
            Box::pin(async move {
                lock(&completed_callback).push(error);
                Ok(())
            })
        }));
        registry.register(command).unwrap();

        let replies = Arc::new(Mutex::new(Vec::new()));
        let mut context = context("Alex", PermissionLevel::Guest, false, &[], replies.clone());
        let result = run(registry.execute("broken", &mut context)).unwrap();
        assert_eq!(result.error.as_deref(), Some("failed"));
        assert_eq!(*lock(&completed), vec![Some("failed".to_owned())]);
        let stats = registry.get_stats(Some("broken")).unwrap();
        assert_eq!(stats[0].failed_executions, 1);
        assert_eq!(stats[0].total_executions, 1);
        assert!(lock(&replies)[0].contains("Command error"));
    }

    #[test]
    fn help_commands_use_registry_metadata_and_permission_levels() {
        let registry = CommandRegistry::new("!", "$");
        registry.register_ping_command().unwrap();
        registry.register_help_command("!").unwrap();
        let full_help = registry.get_full_help("!", PermissionLevel::Guest).unwrap();
        assert!(full_help.contains("!ping"));
        assert!(full_help.contains("!help"));
        assert!(
            registry
                .get_help("ping", "!")
                .unwrap()
                .unwrap()
                .contains("Check bot responsiveness")
        );

        let replies = Arc::new(Mutex::new(Vec::new()));
        let mut context = context("Alex", PermissionLevel::Guest, false, &[], replies.clone());
        assert!(run(registry.execute("ping", &mut context)).unwrap().success);
        assert_eq!(*lock(&replies), vec!["🏓 Pong!".to_owned()]);
    }

    #[test]
    fn execution_errors_are_returned_without_suppressing_callback_errors() {
        let registry = CommandRegistry::default();
        let mut command = CommandDefinition::new("bad-completion", "test", handler(|_| Ok(())));
        command.on_complete = Some(Arc::new(|_, _| {
            Box::pin(async { Err("cleanup failed".to_owned()) })
        }));
        registry.register(command).unwrap();
        let replies = Arc::new(Mutex::new(Vec::new()));
        let mut context = context("Alex", PermissionLevel::Guest, false, &[], replies.clone());
        let result = run(registry.execute("bad-completion", &mut context)).unwrap();
        assert_eq!(
            result.error.as_deref(),
            Some("Completion callback failed: cleanup failed")
        );
        assert_eq!(
            registry.get_stats(Some("bad-completion")).unwrap()[0].failed_executions,
            1
        );
        assert!(lock(&replies)[0].contains("cleanup failed"));
    }
}
