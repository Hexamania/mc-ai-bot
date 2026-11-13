use std::collections::HashMap;

use thiserror::Error;

#[derive(Clone, PartialEq, Eq)]
pub struct AppConfig {
    pub bot: BotConfig,
    pub web: WebConfig,
    pub openai: OpenAiConfig,
    pub memory: MemoryConfig,
    pub admin: AdminConfig,
    pub prefix: PrefixConfig,
}

#[derive(Clone, PartialEq, Eq)]
pub struct BotConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub version: String,
    pub auth: String,
    pub check_timeout_interval: u64,
}

#[derive(Clone, PartialEq, Eq)]
pub struct WebConfig {
    pub port: u16,
    pub host: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct OpenAiConfig {
    pub api_key: String,
    pub model: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct MemoryConfig {
    pub enabled: bool,
    pub file_path: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct AdminConfig {
    pub prefix: String,
    pub password: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct PrefixConfig {
    pub public: String,
    pub admin: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("{name} must be a valid port number from 1 to 65535")]
    InvalidPort { name: &'static str },
    #[error("{name} contains a non-Unicode value")]
    NonUnicode { name: &'static str },
}

impl AppConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let mut values = HashMap::new();
        for name in [
            "MC_HOST",
            "MC_PORT",
            "MC_USERNAME",
            "MC_PASSWORD",
            "MC_VERSION",
            "WEB_PORT",
            "WEB_HOST",
            "OPENAI_API_KEY",
            "OPENAI_KEY",
            "OPENAI_MODEL",
            "ENABLE_MEMORY",
            "MEMORY_FILE",
            "ADMIN_PREFIX",
            "ADMIN_PASSWORD",
            "PREFIX",
        ] {
            match std::env::var(name) {
                Ok(value) => {
                    values.insert(name.to_owned(), value);
                }
                Err(std::env::VarError::NotPresent) => {}
                Err(std::env::VarError::NotUnicode(_)) => {
                    return Err(ConfigError::NonUnicode { name });
                }
            }
        }
        Self::from_values(&values)
    }

    pub fn from_values(values: &HashMap<String, String>) -> Result<Self, ConfigError> {
        let get = |key: &str, default: &str| match values.get(key) {
            Some(value) if !value.is_empty() => value.clone(),
            _ => default.to_owned(),
        };
        let bot_port = parse_port(values, "MC_PORT", 25565)?;
        let web_port = parse_port(values, "WEB_PORT", 3000)?;
        let admin_prefix = get("ADMIN_PREFIX", "$");
        let version = get("MC_VERSION", "1.21.1");
        let version = if version.trim().is_empty() {
            "1.21.1".to_owned()
        } else {
            version.trim().to_owned()
        };

        Ok(Self {
            bot: BotConfig {
                host: get("MC_HOST", "localhost"),
                port: bot_port,
                username: get("MC_USERNAME", "Airi"),
                password: values.get("MC_PASSWORD").cloned(),
                version,
                auth: "offline".to_owned(),
                check_timeout_interval: 60_000,
            },
            web: WebConfig {
                port: web_port,
                host: values
                    .get("WEB_HOST")
                    .filter(|value| !value.is_empty())
                    .cloned(),
            },
            openai: OpenAiConfig {
                api_key: values
                    .get("OPENAI_API_KEY")
                    .filter(|value| !value.is_empty())
                    .or_else(|| values.get("OPENAI_KEY"))
                    .cloned()
                    .unwrap_or_default(),
                model: get("OPENAI_MODEL", "gpt-4"),
            },
            memory: MemoryConfig {
                enabled: values
                    .get("ENABLE_MEMORY")
                    .is_some_and(|value| value == "true"),
                file_path: get("MEMORY_FILE", "./memory.json"),
            },
            admin: AdminConfig {
                prefix: admin_prefix.clone(),
                password: get("ADMIN_PASSWORD", "admin"),
            },
            prefix: PrefixConfig {
                public: get("PREFIX", ":"),
                admin: admin_prefix,
            },
        })
    }

    pub fn validate(&self) -> Vec<&'static str> {
        let mut errors = Vec::new();
        if self.bot.host.is_empty() {
            errors.push("MC_HOST is required");
        }
        if self.bot.username.is_empty() {
            errors.push("MC_USERNAME is required");
        }
        if self.bot.port == 0 {
            errors.push("MC_PORT must be between 1 and 65535");
        }
        if self.web.port == 0 {
            errors.push("WEB_PORT must be between 1 and 65535");
        }
        errors
    }
}

fn parse_port(
    values: &HashMap<String, String>,
    name: &'static str,
    default: u16,
) -> Result<u16, ConfigError> {
    match values.get(name) {
        None => Ok(default),
        Some(value) if value.is_empty() => Ok(default),
        Some(value) => value
            .trim()
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or(ConfigError::InvalidPort { name }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_existing_application() {
        let config = AppConfig::from_values(&HashMap::new()).unwrap();

        assert_eq!(config.bot.host, "localhost");
        assert_eq!(config.bot.port, 25565);
        assert_eq!(config.bot.username, "Airi");
        assert_eq!(config.bot.version, "1.21.1");
        assert_eq!(config.web.port, 3000);
        assert_eq!(config.openai.model, "gpt-4");
        assert!(!config.memory.enabled);
        assert_eq!(config.prefix.public, ":");
        assert_eq!(config.admin.prefix, "$");
    }

    #[test]
    fn environment_values_are_trimmed_and_openai_key_has_a_fallback() {
        let values = HashMap::from([
            ("MC_VERSION".to_owned(), " 1.20.4 ".to_owned()),
            ("MC_PORT".to_owned(), "12345".to_owned()),
            ("OPENAI_API_KEY".to_owned(), String::new()),
            ("OPENAI_KEY".to_owned(), "fallback".to_owned()),
            ("ADMIN_PREFIX".to_owned(), "!".to_owned()),
        ]);
        let config = AppConfig::from_values(&values).unwrap();

        assert_eq!(config.bot.version, "1.20.4");
        assert_eq!(config.bot.port, 12345);
        assert_eq!(config.openai.api_key, "fallback");
        assert_eq!(config.prefix.admin, "!");
    }

    #[test]
    fn invalid_ports_are_reported_instead_of_silently_defaulted() {
        for value in ["0", "65536", "not-a-port"] {
            let values = HashMap::from([("WEB_PORT".to_owned(), value.to_owned())]);
            assert!(matches!(
                AppConfig::from_values(&values),
                Err(ConfigError::InvalidPort { name: "WEB_PORT" })
            ));
        }
    }

    #[test]
    fn empty_port_uses_the_configured_default() {
        let values = HashMap::from([("MC_PORT".to_owned(), String::new())]);
        let config = AppConfig::from_values(&values).unwrap();
        assert_eq!(config.bot.port, 25565);
    }

    #[test]
    fn validation_reports_required_bot_settings() {
        let mut config = AppConfig::from_values(&HashMap::new()).unwrap();
        config.bot.host.clear();
        config.bot.username.clear();

        assert_eq!(
            config.validate(),
            vec!["MC_HOST is required", "MC_USERNAME is required"]
        );
    }
}
