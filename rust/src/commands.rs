use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MessageType {
    #[default]
    Chat,
    PrivateMessage,
    Whisper,
    System,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedMessage {
    pub username: String,
    pub content: String,
    pub message_type: MessageType,
    pub raw: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedInput {
    pub message: ParsedMessage,
    pub command_name: Option<String>,
    pub args: Vec<String>,
    pub is_admin_command: bool,
    pub prefix: Option<String>,
}

impl ParsedInput {
    pub fn is_command(&self) -> bool {
        self.command_name.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatParserConfig {
    pub public_prefix: String,
    pub admin_prefix: String,
    pub ignore_bot_messages: bool,
}

impl Default for ChatParserConfig {
    fn default() -> Self {
        Self {
            public_prefix: "!".to_owned(),
            admin_prefix: "$".to_owned(),
            ignore_bot_messages: true,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ChatParser {
    config: ChatParserConfig,
    bot_username: Option<String>,
}

impl ChatParser {
    pub fn new(config: ChatParserConfig) -> Self {
        Self {
            config,
            bot_username: None,
        }
    }

    pub fn set_bot_username(&mut self, username: Option<String>) {
        self.bot_username = username;
    }

    pub fn update_config(&mut self, config: ChatParserConfig) {
        self.config = config;
    }

    pub fn parse(&self, raw: &str) -> Option<ParsedInput> {
        let message = parse_message_format(raw)?;
        if self.config.ignore_bot_messages
            && self
                .bot_username
                .as_deref()
                .is_some_and(|username| username.eq_ignore_ascii_case(&message.username))
        {
            return None;
        }

        let Some((command_name, args, is_admin_command, prefix)) =
            parse_command(&message.content, &self.config)
        else {
            return Some(ParsedInput {
                message,
                command_name: None,
                args: Vec::new(),
                is_admin_command: false,
                prefix: None,
            });
        };

        Some(ParsedInput {
            message,
            command_name: Some(command_name),
            args,
            is_admin_command,
            prefix: Some(prefix),
        })
    }
}

fn parse_message_format(raw: &str) -> Option<ParsedMessage> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some((header, content)) = rest.split_once(']') {
            let content = content.trim_start();
            if let Some(username) = header.strip_suffix(" -> me") {
                if !username.is_empty() && !content.is_empty() {
                    return Some(parsed_message(
                        username,
                        content,
                        MessageType::PrivateMessage,
                        trimmed,
                    ));
                }
            }

            if ["server", "console", "system"]
                .iter()
                .any(|tag| header.eq_ignore_ascii_case(tag))
                && !content.is_empty()
            {
                return Some(parsed_message(
                    header,
                    content,
                    MessageType::System,
                    trimmed,
                ));
            }
        }
    }

    if let Some((username, content)) = whisper_parts(trimmed) {
        if !username.is_empty() && !content.is_empty() {
            return Some(parsed_message(
                username,
                content,
                MessageType::Whisper,
                trimmed,
            ));
        }
    }

    if let Some(rest) = trimmed.strip_prefix('<') {
        if let Some((username, content)) = rest.split_once('>') {
            let content = content.trim_start();
            if !username.is_empty() && !content.is_empty() {
                return Some(parsed_message(
                    username,
                    content,
                    MessageType::Chat,
                    trimmed,
                ));
            }
        }
    }

    if let Some((user_part, content)) = trimmed.split_once('»') {
        if let Some(username) = minecraft_username(user_part) {
            let content = content.trim();
            if !content.is_empty() {
                return Some(parsed_message(
                    username,
                    content,
                    MessageType::Chat,
                    trimmed,
                ));
            }
        }
    }

    if let Some(rest) = trimmed.strip_prefix('*') {
        let rest = rest.trim_start();
        if let Some(index) = rest.find(char::is_whitespace) {
            let username = &rest[..index];
            let content = rest[index..].trim();
            if !username.is_empty() && !content.is_empty() {
                return Some(parsed_message(
                    username,
                    content,
                    MessageType::Chat,
                    trimmed,
                ));
            }
        }
    }

    if let Some(rest) = trimmed.strip_prefix('(') {
        if let Some((username, content)) = rest.split_once(')') {
            let content = content.trim_start();
            if !username.is_empty() && !content.is_empty() {
                return Some(parsed_message(
                    username,
                    content,
                    MessageType::Chat,
                    trimmed,
                ));
            }
        }
    }

    None
}

fn whisper_parts(message: &str) -> Option<(&str, &str)> {
    let lowercase = message.to_ascii_lowercase();
    for (index, _) in lowercase.match_indices("whisper") {
        let username = message[..index].trim_end();
        if username.is_empty()
            || !message[username.len()..index]
                .chars()
                .all(char::is_whitespace)
        {
            continue;
        }

        let mut suffix_index = index + "whisper".len();
        if lowercase.as_bytes().get(suffix_index) == Some(&b's') {
            suffix_index += 1;
        }
        let suffix = &lowercase[suffix_index..];
        let to_index = skip_whitespace(suffix);
        if to_index == 0 || !suffix[to_index..].starts_with("to") {
            continue;
        }

        let suffix = &suffix[to_index + "to".len()..];
        let you_index = skip_whitespace(suffix);
        if you_index == 0 || !suffix[you_index..].starts_with("you:") {
            continue;
        }

        let content_index = suffix_index + to_index + "to".len() + you_index + "you:".len();
        let content = message[content_index..].trim_start();
        if !content.is_empty() {
            return Some((username, content));
        }
    }
    None
}

fn skip_whitespace(value: &str) -> usize {
    value
        .char_indices()
        .take_while(|(_, character)| character.is_whitespace())
        .map(|(index, character)| index + character.len_utf8())
        .last()
        .unwrap_or(0)
}

fn parsed_message(
    username: &str,
    content: &str,
    message_type: MessageType,
    raw: &str,
) -> ParsedMessage {
    ParsedMessage {
        username: username.to_owned(),
        content: content.to_owned(),
        message_type,
        raw: raw.to_owned(),
    }
}

fn minecraft_username(value: &str) -> Option<&str> {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_alphanumeric() && bytes[index] != b'_' {
            index += 1;
            continue;
        }

        let start = index;
        while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
        {
            index += 1;
        }
        if index - start >= 3 {
            return Some(&value[start..(start + 16).min(index)]);
        }
    }
    None
}

fn parse_command(
    content: &str,
    config: &ChatParserConfig,
) -> Option<(String, Vec<String>, bool, String)> {
    let trimmed = content.trim();
    let candidates = [
        (config.admin_prefix.as_str(), true),
        (config.public_prefix.as_str(), false),
        ("/", false),
    ];

    for (prefix, is_admin) in candidates {
        if prefix.is_empty() || !trimmed.starts_with(prefix) {
            continue;
        }
        let command_text = trimmed[prefix.len()..].trim();
        let mut parts = split_arguments(command_text);
        if parts.is_empty() {
            return None;
        }
        let command_name = parts.remove(0).to_lowercase();
        if command_name.is_empty() {
            return None;
        }
        return Some((command_name, parts, is_admin, prefix.to_owned()));
    }
    None
}

pub fn split_arguments(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut chars = input.chars();

    while let Some(character) = chars.next() {
        if quote.is_some() && character == '\\' {
            match chars.next() {
                Some(escaped) => current.push(escaped),
                None => current.push('\\'),
            }
        } else if character == '"' || character == '\'' {
            match quote {
                None => quote = Some(character),
                Some(active) if active == character => quote = None,
                Some(_) => current.push(character),
            }
        } else if character.is_whitespace() && quote.is_none() {
            if !current.is_empty() {
                args.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }

    if !current.is_empty() {
        args.push(current);
    }
    args
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum PermissionLevel {
    #[default]
    Guest,
    Trusted,
    Admin,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PermissionConfig {
    pub level: PermissionLevel,
    pub allowed_users: Vec<String>,
    pub denied_users: Vec<String>,
    pub pm_only: bool,
    pub public_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionDecision {
    pub allowed: bool,
    pub reason: Option<&'static str>,
}

impl PermissionDecision {
    fn allow() -> Self {
        Self {
            allowed: true,
            reason: None,
        }
    }

    fn deny(reason: &'static str) -> Self {
        Self {
            allowed: false,
            reason: Some(reason),
        }
    }
}

#[derive(Default)]
pub struct PermissionManager {
    roles: HashMap<String, PermissionLevel>,
    admin_sessions: HashSet<String>,
    admin_password: String,
}

impl PermissionManager {
    pub fn new(admin_password: impl Into<String>) -> Self {
        Self {
            roles: HashMap::new(),
            admin_sessions: HashSet::new(),
            admin_password: admin_password.into(),
        }
    }

    pub fn permission_level(&self, username: &str) -> PermissionLevel {
        let username = normalize_username(username);
        if self.admin_sessions.contains(&username) {
            PermissionLevel::Admin
        } else {
            self.roles.get(&username).copied().unwrap_or_default()
        }
    }

    pub fn is_admin(&self, username: &str) -> bool {
        self.permission_level(username) == PermissionLevel::Admin
    }

    pub fn is_trusted(&self, username: &str) -> bool {
        self.permission_level(username) >= PermissionLevel::Trusted
    }

    pub fn set_role(&mut self, username: &str, role: PermissionLevel) -> bool {
        let username = normalize_username(username);
        if username.is_empty() {
            return false;
        }
        if role == PermissionLevel::Guest {
            self.roles.remove(&username);
        } else {
            self.roles.insert(username, role);
        }
        true
    }

    pub fn promote(&mut self, username: &str) -> bool {
        let promoted = match self.permission_level(username) {
            PermissionLevel::Guest => PermissionLevel::Trusted,
            PermissionLevel::Trusted => PermissionLevel::Admin,
            PermissionLevel::Admin => return false,
        };
        self.set_role(username, promoted)
    }

    pub fn demote(&mut self, username: &str) -> bool {
        let demoted = match self.permission_level(username) {
            PermissionLevel::Guest => return false,
            PermissionLevel::Trusted => PermissionLevel::Guest,
            PermissionLevel::Admin => PermissionLevel::Trusted,
        };
        self.set_role(username, demoted)
    }

    pub fn try_admin_login(&mut self, username: &str, password: &str) -> bool {
        if self.admin_password.is_empty() || password != self.admin_password {
            return false;
        }
        let username = normalize_username(username);
        if username.is_empty() {
            return false;
        }
        self.admin_sessions.insert(username);
        true
    }

    pub fn logout_admin(&mut self, username: &str) {
        self.admin_sessions.remove(&normalize_username(username));
    }

    pub fn has_admin_session(&self, username: &str) -> bool {
        self.admin_sessions.contains(&normalize_username(username))
    }

    pub fn clear_admin_sessions(&mut self) {
        self.admin_sessions.clear();
    }

    pub fn set_admin_password(&mut self, password: impl Into<String>) {
        self.admin_password = password.into();
    }

    pub fn check_permission(
        &self,
        username: &str,
        config: &PermissionConfig,
        is_private_message: bool,
    ) -> PermissionDecision {
        if config
            .denied_users
            .iter()
            .any(|denied| denied.eq_ignore_ascii_case(username))
        {
            return PermissionDecision::deny("User is denied access");
        }
        if config
            .allowed_users
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(username))
        {
            return PermissionDecision::allow();
        }
        if config.pm_only && !is_private_message {
            return PermissionDecision::deny("Command can only be used in private messages");
        }
        if config.public_only && is_private_message {
            return PermissionDecision::deny("Command can only be used in public chat");
        }
        if self.permission_level(username) < config.level {
            return PermissionDecision::deny(match config.level {
                PermissionLevel::Guest => "Requires guest permission",
                PermissionLevel::Trusted => "Requires trusted permission",
                PermissionLevel::Admin => "Requires admin permission",
            });
        }
        PermissionDecision::allow()
    }
}

fn normalize_username(username: &str) -> String {
    username.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parser() -> ChatParser {
        ChatParser::default()
    }

    #[test]
    fn parses_chat_and_quoted_command_arguments() {
        let parsed = parser()
            .parse(r#"<Alex> !CHAT "hello there" 'two words'"#)
            .unwrap();
        assert_eq!(parsed.message.username, "Alex");
        assert_eq!(parsed.command_name.as_deref(), Some("chat"));
        assert_eq!(parsed.args, ["hello there", "two words"]);
        assert_eq!(parsed.prefix.as_deref(), Some("!"));
        assert!(!parsed.is_admin_command);
    }

    #[test]
    fn parses_private_whisper_and_admin_prefixes() {
        let parsed = parser().parse("[Alex -> me] $Guard north").unwrap();
        assert_eq!(parsed.message.message_type, MessageType::PrivateMessage);
        assert_eq!(parsed.command_name.as_deref(), Some("guard"));
        assert!(parsed.is_admin_command);

        let parsed = parser().parse("Alex\t whispers \tto\tyou: !Ping").unwrap();
        assert_eq!(parsed.message.message_type, MessageType::Whisper);
        assert_eq!(parsed.command_name.as_deref(), Some("ping"));

        let parsed = parser().parse("Alex whisper to you: !Ping").unwrap();
        assert_eq!(parsed.message.message_type, MessageType::Whisper);
    }

    #[test]
    fn parses_alternate_chat_action_system_and_slash_messages() {
        let parsed = parser().parse("RankedPlayer » /help").unwrap();
        assert_eq!(parsed.message.username, "RankedPlayer");
        assert_eq!(parsed.command_name.as_deref(), Some("help"));
        assert_eq!(parsed.prefix.as_deref(), Some("/"));

        let parsed = parser().parse("* Alex !status").unwrap();
        assert_eq!(parsed.command_name.as_deref(), Some("status"));

        let parsed = parser().parse("[Server] Restart soon").unwrap();
        assert_eq!(parsed.message.message_type, MessageType::System);
        assert!(!parsed.is_command());
    }

    #[test]
    fn ignores_own_messages_and_preserves_non_command_chat() {
        let mut parser = parser();
        parser.set_bot_username(Some("Airi".to_owned()));
        assert!(parser.parse("<airi> !ping").is_none());

        let parsed = parser.parse("<Alex> hello").unwrap();
        assert!(!parsed.is_command());
        assert_eq!(parsed.message.content, "hello");
        assert!(parser.parse("unrecognized format").is_none());
    }

    #[test]
    fn empty_prefixes_do_not_turn_all_messages_into_commands() {
        let parser = ChatParser::new(ChatParserConfig {
            public_prefix: String::new(),
            admin_prefix: String::new(),
            ignore_bot_messages: true,
        });
        let parsed = parser.parse("<Alex> ordinary message").unwrap();
        assert!(!parsed.is_command());
    }

    #[test]
    fn argument_parser_handles_escapes_mixed_quotes_and_unclosed_quotes() {
        assert_eq!(
            split_arguments(r#"say "a \"quoted\" phrase" 'mixed "quotes' tail"#),
            ["say", r#"a "quoted" phrase"#, "mixed \"quotes", "tail"]
        );
        assert_eq!(split_arguments(r#"say "unfinished phrase"#), [
            "say",
            "unfinished phrase"
        ]);
    }

    #[test]
    fn permission_hierarchy_and_role_changes_are_consistent() {
        let mut permissions = PermissionManager::default();
        assert_eq!(permissions.permission_level("Alex"), PermissionLevel::Guest);
        assert!(permissions.promote("Alex"));
        assert!(permissions.is_trusted("aLeX"));
        assert!(permissions.promote("Alex"));
        assert!(permissions.is_admin("ALEX"));
        assert!(!permissions.promote("Alex"));
        assert!(permissions.demote("Alex"));
        assert_eq!(
            permissions.permission_level("alex"),
            PermissionLevel::Trusted
        );
        assert!(permissions.demote("Alex"));
        assert!(!permissions.demote("Alex"));
    }

    #[test]
    fn admin_sessions_require_the_configured_password_and_can_be_cleared() {
        let mut permissions = PermissionManager::new("secret");
        assert!(!permissions.try_admin_login("Alex", ""));
        assert!(!permissions.try_admin_login("Alex", "wrong"));
        assert!(permissions.try_admin_login("Alex", "secret"));
        assert!(permissions.has_admin_session("aLeX"));
        assert!(permissions.is_admin("alex"));
        permissions.logout_admin("ALEX");
        assert!(!permissions.has_admin_session("Alex"));
        assert!(!permissions.is_admin("Alex"));

        permissions.set_admin_password("updated");
        assert!(!permissions.try_admin_login("Alex", "secret"));
        assert!(permissions.try_admin_login("Alex", "updated"));
        permissions.clear_admin_sessions();
        assert!(!permissions.is_admin("Alex"));
    }

    #[test]
    fn allow_and_deny_lists_precede_message_context_and_role_checks() {
        let permissions = PermissionManager::default();
        let private_admin_only = PermissionConfig {
            level: PermissionLevel::Admin,
            allowed_users: vec!["trusted-player".to_owned()],
            denied_users: vec!["BLOCKED".to_owned()],
            pm_only: true,
            public_only: false,
        };

        assert!(
            permissions
                .check_permission("TRUSTED-PLAYER", &private_admin_only, false)
                .allowed
        );
        assert_eq!(
            permissions
                .check_permission("blocked", &private_admin_only, true)
                .reason,
            Some("User is denied access")
        );
        assert_eq!(
            permissions
                .check_permission("guest", &private_admin_only, false)
                .reason,
            Some("Command can only be used in private messages")
        );
        assert_eq!(
            permissions
                .check_permission("guest", &private_admin_only, true)
                .reason,
            Some("Requires admin permission")
        );
    }

    #[test]
    fn public_only_commands_reject_private_messages() {
        let permissions = PermissionManager::default();
        let config = PermissionConfig {
            public_only: true,
            ..PermissionConfig::default()
        };
        assert_eq!(
            permissions.check_permission("guest", &config, true).reason,
            Some("Command can only be used in public chat")
        );
        assert!(
            permissions
                .check_permission("guest", &config, false)
                .allowed
        );
    }
}
