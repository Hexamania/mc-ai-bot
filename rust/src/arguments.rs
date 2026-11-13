use std::collections::BTreeMap;

use thiserror::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArgumentType {
    String,
    Number,
    Boolean,
    Player,
    Position,
    Item,
    Enum,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptionType {
    Boolean,
    String,
    Number,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Position {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ArgumentValue {
    String(String),
    Number(f64),
    Boolean(bool),
    Player(String),
    Position(Position),
    Item(String),
    List(Vec<ArgumentValue>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum ArgumentConstraint {
    Integer,
    Minimum(f64),
    Maximum(f64),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ArgumentDefinition {
    pub name: String,
    pub kind: ArgumentType,
    pub required: bool,
    pub default_value: Option<ArgumentValue>,
    pub enum_values: Vec<String>,
    pub greedy: bool,
    pub constraints: Vec<ArgumentConstraint>,
}

impl ArgumentDefinition {
    pub fn new(name: impl Into<String>, kind: ArgumentType, required: bool) -> Self {
        Self {
            name: name.into(),
            kind,
            required,
            default_value: None,
            enum_values: Vec::new(),
            greedy: false,
            constraints: Vec::new(),
        }
    }

    pub fn with_default(mut self, value: ArgumentValue) -> Self {
        self.default_value = Some(value);
        self
    }

    pub fn with_enum_values(mut self, values: impl IntoIterator<Item = String>) -> Self {
        self.enum_values = values.into_iter().collect();
        self
    }

    pub fn greedy(mut self) -> Self {
        self.greedy = true;
        self
    }

    pub fn with_constraint(mut self, constraint: ArgumentConstraint) -> Self {
        self.constraints.push(constraint);
        self
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct OptionDefinition {
    pub name: String,
    pub alias: Option<char>,
    pub kind: OptionType,
    pub has_value: bool,
    pub default_value: Option<ArgumentValue>,
}

impl OptionDefinition {
    pub fn new(name: impl Into<String>, kind: OptionType, has_value: bool) -> Self {
        Self {
            name: name.into(),
            alias: None,
            kind,
            has_value,
            default_value: None,
        }
    }

    pub fn with_alias(mut self, alias: char) -> Self {
        self.alias = Some(alias);
        self
    }

    pub fn with_default(mut self, value: ArgumentValue) -> Self {
        self.default_value = Some(value);
        self
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ArgumentContext {
    pub online_players: Option<Vec<String>>,
    pub item_names: Option<Vec<String>>,
    pub current_position: Option<Position>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParsedArguments {
    pub args: Vec<ArgumentValue>,
    pub options: BTreeMap<String, ArgumentValue>,
    pub raw: Vec<String>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("{0}")]
pub struct ArgumentParseError(pub String);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ArgumentParser {
    context: ArgumentContext,
}

impl ArgumentParser {
    pub fn new(context: ArgumentContext) -> Self {
        Self { context }
    }

    pub fn parse(
        &self,
        raw_args: &[String],
        argument_definitions: &[ArgumentDefinition],
        option_definitions: &[OptionDefinition],
    ) -> Result<ParsedArguments, ArgumentParseError> {
        let mut options = BTreeMap::new();
        let mut remaining = Vec::new();
        let mut index = 0;

        while index < raw_args.len() {
            let token = &raw_args[index];
            if let Some(name) = token.strip_prefix("--") {
                if let Some(definition) = option_definitions.iter().find(|item| item.name == name) {
                    if definition.has_value {
                        if let Some(value) = raw_args.get(index + 1) {
                            options.insert(
                                definition.name.clone(),
                                self.parse_option_value(value, definition)?,
                            );
                            index += 2;
                            continue;
                        }
                        options.insert(
                            definition.name.clone(),
                            option_fallback(definition.default_value.as_ref()),
                        );
                    } else {
                        options.insert(definition.name.clone(), ArgumentValue::Boolean(true));
                    }
                } else {
                    remaining.push(token.clone());
                }
                index += 1;
                continue;
            }

            if token.starts_with('-') && token.len() > 1 {
                let aliases = token[1..].chars().collect::<Vec<_>>();
                let definitions = aliases
                    .iter()
                    .map(|alias| {
                        option_definitions
                            .iter()
                            .find(|item| item.alias == Some(*alias))
                    })
                    .collect::<Option<Vec<_>>>();

                if let Some(definitions) = definitions {
                    let mut next_index = index + 1;
                    for definition in definitions {
                        if definition.has_value {
                            if let Some(value) = raw_args.get(next_index) {
                                options.insert(
                                    definition.name.clone(),
                                    self.parse_option_value(value, definition)?,
                                );
                                next_index += 1;
                            } else {
                                options.insert(
                                    definition.name.clone(),
                                    option_fallback(definition.default_value.as_ref()),
                                );
                            }
                        } else {
                            options.insert(definition.name.clone(), ArgumentValue::Boolean(true));
                        }
                    }
                    index = next_index;
                } else {
                    remaining.push(token.clone());
                    index += 1;
                }
                continue;
            }

            remaining.push(token.clone());
            index += 1;
        }

        let mut args = Vec::new();
        let mut arg_index = 0;
        for definition in argument_definitions {
            if definition.greedy {
                let values = remaining[arg_index..]
                    .iter()
                    .map(|value| self.parse_value(value, definition))
                    .collect::<Result<Vec<_>, _>>()?;
                if !values.is_empty() {
                    args.push(ArgumentValue::List(values));
                } else if definition.required {
                    return Err(missing_argument(definition));
                } else if let Some(value) = &definition.default_value {
                    args.push(value.clone());
                }
                arg_index = remaining.len();
                break;
            }

            if let Some(value) = remaining.get(arg_index) {
                args.push(self.parse_value(value, definition)?);
                arg_index += 1;
            } else if definition.required {
                return Err(missing_argument(definition));
            } else if let Some(value) = &definition.default_value {
                args.push(value.clone());
            }
        }

        args.extend(
            remaining[arg_index..]
                .iter()
                .cloned()
                .map(ArgumentValue::String),
        );

        for definition in option_definitions {
            if !options.contains_key(&definition.name) {
                if let Some(value) = &definition.default_value {
                    options.insert(definition.name.clone(), value.clone());
                }
            }
        }

        Ok(ParsedArguments {
            args,
            options,
            raw: raw_args.to_vec(),
        })
    }

    pub fn parse_value(
        &self,
        value: &str,
        definition: &ArgumentDefinition,
    ) -> Result<ArgumentValue, ArgumentParseError> {
        let value = value.trim();
        if value.is_empty() {
            if let Some(default_value) = &definition.default_value {
                return Ok(default_value.clone());
            }
            return Err(ArgumentParseError(format!(
                "Argument \"{}\" cannot be empty",
                definition.name
            )));
        }

        let parsed = match definition.kind {
            ArgumentType::String => ArgumentValue::String(value.to_owned()),
            ArgumentType::Number => ArgumentValue::Number(parse_number(value)?),
            ArgumentType::Boolean => ArgumentValue::Boolean(matches!(
                value.to_ascii_lowercase().as_str(),
                "true" | "1" | "yes" | "on"
            )),
            ArgumentType::Player => ArgumentValue::Player(self.resolve_player(value)?),
            ArgumentType::Position => ArgumentValue::Position(parse_position(
                value,
                self.context.current_position.as_ref(),
            )?),
            ArgumentType::Item => ArgumentValue::Item(self.resolve_item(value)?),
            ArgumentType::Enum if !definition.enum_values.is_empty() => {
                let matching = definition
                    .enum_values
                    .iter()
                    .find(|candidate| candidate.eq_ignore_ascii_case(value))
                    .ok_or_else(|| {
                        ArgumentParseError(format!(
                            "Invalid value: {value}. Allowed: {}",
                            definition.enum_values.join(", ")
                        ))
                    })?;
                ArgumentValue::String(matching.clone())
            }
            ArgumentType::Enum => ArgumentValue::String(value.to_owned()),
        };

        validate_constraints(&parsed, definition)?;
        Ok(parsed)
    }

    pub fn get_suggestions(&self, partial: &str, definition: &ArgumentDefinition) -> Vec<String> {
        let lower_partial = partial.to_ascii_lowercase();
        match definition.kind {
            ArgumentType::Player => self
                .context
                .online_players
                .iter()
                .flatten()
                .filter(|name| name.to_ascii_lowercase().starts_with(&lower_partial))
                .take(10)
                .cloned()
                .collect(),
            ArgumentType::Item => self
                .context
                .item_names
                .iter()
                .flatten()
                .filter(|name| name.to_ascii_lowercase().contains(&lower_partial))
                .take(10)
                .cloned()
                .collect(),
            ArgumentType::Position => {
                let suggestions = self
                    .context
                    .current_position
                    .as_ref()
                    .map(|position| {
                        vec![
                            "~ ~ ~".to_owned(),
                            format!(
                                "~{:.0} ~{:.0} ~{:.0}",
                                position.x.floor(),
                                position.y.floor(),
                                position.z.floor()
                            ),
                            format!(
                                "{:.0} {:.0} {:.0}",
                                position.x.floor(),
                                position.y.floor(),
                                position.z.floor()
                            ),
                        ]
                    })
                    .unwrap_or_else(|| vec!["~ ~ ~".to_owned()]);
                suggestions
                    .into_iter()
                    .filter(|value| value.to_ascii_lowercase().starts_with(&lower_partial))
                    .collect()
            }
            ArgumentType::Enum => definition
                .enum_values
                .iter()
                .filter(|value| value.to_ascii_lowercase().starts_with(&lower_partial))
                .take(10)
                .cloned()
                .collect(),
            ArgumentType::Number => ["1", "10", "64", "100", "1000"]
                .iter()
                .filter(|value| value.starts_with(partial))
                .take(5)
                .map(|value| (*value).to_owned())
                .collect(),
            ArgumentType::Boolean => ["true", "false"]
                .iter()
                .filter(|value| value.starts_with(&lower_partial))
                .map(|value| (*value).to_owned())
                .collect(),
            ArgumentType::String => Vec::new(),
        }
    }

    pub fn format_argument(definition: &ArgumentDefinition) -> String {
        let (start, end) = if definition.required {
            ("<", ">")
        } else {
            ("[", "]")
        };
        let kind = if definition.kind == ArgumentType::Enum && !definition.enum_values.is_empty() {
            definition.enum_values.join("|")
        } else {
            argument_type_name(definition.kind).to_owned()
        };
        let mut output = format!("{start}{}: {kind}{end}", definition.name);
        if let Some(default) = &definition.default_value {
            output.push_str(&format!(" (default: {})", display_value(default)));
        }
        if definition.greedy {
            output.push_str("...");
        }
        output
    }

    pub fn format_option(definition: &OptionDefinition) -> String {
        let alias = definition
            .alias
            .map(|value| format!(", -{value}"))
            .unwrap_or_default();
        let value = if definition.has_value {
            format!(" <{}>", option_type_name(definition.kind))
        } else {
            String::new()
        };
        let default = definition
            .default_value
            .as_ref()
            .map(|value| format!(" (default: {})", display_value(value)))
            .unwrap_or_default();
        format!("--{}{}{}{}", definition.name, alias, value, default)
    }

    pub fn validate(
        parsed: &ParsedArguments,
        argument_definitions: &[ArgumentDefinition],
        _option_definitions: &[OptionDefinition],
    ) -> ValidationResult {
        let mut errors = Vec::new();
        for (index, definition) in argument_definitions.iter().enumerate() {
            let Some(value) = parsed.args.get(index) else {
                if definition.required {
                    errors.push(format!("Missing required argument: {}", definition.name));
                }
                continue;
            };
            if let Err(error) = validate_constraints(value, definition) {
                errors.push(error.to_string());
            }
            if definition.kind == ArgumentType::Enum
                && !definition.enum_values.is_empty()
                && !enum_value_matches(value, &definition.enum_values)
            {
                errors.push(format!(
                    "Invalid value for {}: {}. Allowed: {}",
                    definition.name,
                    display_value(value),
                    definition.enum_values.join(", ")
                ));
            }
        }

        ValidationResult {
            valid: errors.is_empty(),
            errors,
        }
    }

    fn parse_option_value(
        &self,
        value: &str,
        definition: &OptionDefinition,
    ) -> Result<ArgumentValue, ArgumentParseError> {
        match definition.kind {
            OptionType::Boolean => Ok(ArgumentValue::Boolean(matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "true" | "1" | "yes" | "on"
            ))),
            OptionType::String => Ok(ArgumentValue::String(value.trim().to_owned())),
            OptionType::Number => Ok(ArgumentValue::Number(parse_number(value.trim()).map_err(
                |error| {
                    ArgumentParseError(format!(
                        "Invalid value for --{}: {}",
                        definition.name, error.0
                    ))
                },
            )?)),
        }
    }

    fn resolve_player(&self, value: &str) -> Result<String, ArgumentParseError> {
        let Some(players) = &self.context.online_players else {
            return Ok(value.to_owned());
        };
        players
            .iter()
            .find(|player| player.eq_ignore_ascii_case(value))
            .cloned()
            .ok_or_else(|| ArgumentParseError(format!("Player \"{value}\" not found")))
    }

    fn resolve_item(&self, value: &str) -> Result<String, ArgumentParseError> {
        let Some(items) = &self.context.item_names else {
            return Ok(value.to_owned());
        };
        if let Some(item) = items.iter().find(|item| item.eq_ignore_ascii_case(value)) {
            return Ok(item.clone());
        }
        let matches = items
            .iter()
            .filter(|item| {
                item.to_ascii_lowercase()
                    .contains(&value.to_ascii_lowercase())
            })
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [item] => Ok((*item).clone()),
            [] => Err(ArgumentParseError(format!("Item \"{value}\" not found"))),
            _ => Err(ArgumentParseError(format!(
                "Ambiguous item: {value}. Matches: {}",
                matches
                    .iter()
                    .map(|item| item.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))),
        }
    }
}

fn option_fallback(default_value: Option<&ArgumentValue>) -> ArgumentValue {
    default_value
        .cloned()
        .unwrap_or(ArgumentValue::Boolean(true))
}

fn missing_argument(definition: &ArgumentDefinition) -> ArgumentParseError {
    ArgumentParseError(format!("Missing required argument: {}", definition.name))
}

fn parse_number(value: &str) -> Result<f64, ArgumentParseError> {
    value
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .ok_or_else(|| ArgumentParseError(format!("Expected number, got: {value}")))
}

fn parse_position(value: &str, origin: Option<&Position>) -> Result<Position, ArgumentParseError> {
    let coordinates = value
        .split(|character: char| character.is_whitespace() || character == ',')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if coordinates.len() != 3 {
        return Err(ArgumentParseError(format!(
            "Invalid position format: {value}"
        )));
    }

    let relative = coordinates
        .iter()
        .any(|coordinate| coordinate.starts_with('~'));
    let relative_origin = if relative {
        Some(origin.ok_or_else(|| {
            ArgumentParseError(
                "Cannot parse relative position: current position unavailable".to_owned(),
            )
        })?)
    } else {
        None
    };
    let axes = [0.0, 0.0, 0.0];
    let mut values = axes;
    for (index, coordinate) in coordinates.iter().enumerate() {
        values[index] = if let Some(offset) = coordinate.strip_prefix('~') {
            let position = relative_origin.ok_or_else(|| {
                ArgumentParseError(
                    "Cannot parse relative position: current position unavailable".to_owned(),
                )
            })?;
            let current = [position.x, position.y, position.z][index];
            if offset.is_empty() {
                current
            } else {
                current + parse_number(offset)?
            }
        } else {
            parse_number(coordinate)?
        };
    }
    Ok(Position {
        x: values[0],
        y: values[1],
        z: values[2],
    })
}

fn validate_constraints(
    value: &ArgumentValue,
    definition: &ArgumentDefinition,
) -> Result<(), ArgumentParseError> {
    let ArgumentValue::Number(number) = value else {
        return Ok(());
    };
    for constraint in &definition.constraints {
        match constraint {
            ArgumentConstraint::Integer if number.fract() != 0.0 => {
                return Err(ArgumentParseError("Must be an integer".to_owned()));
            }
            ArgumentConstraint::Minimum(minimum) if number < minimum => {
                return Err(ArgumentParseError(format!("Must be at least {minimum}")));
            }
            ArgumentConstraint::Maximum(maximum) if number > maximum => {
                return Err(ArgumentParseError(format!("Must be at most {maximum}")));
            }
            _ => {}
        }
    }
    Ok(())
}

fn enum_value_matches(value: &ArgumentValue, enum_values: &[String]) -> bool {
    matches!(value, ArgumentValue::String(value) if enum_values.iter().any(|allowed| allowed == value))
}

fn argument_type_name(kind: ArgumentType) -> &'static str {
    match kind {
        ArgumentType::String => "string",
        ArgumentType::Number => "number",
        ArgumentType::Boolean => "boolean",
        ArgumentType::Player => "player",
        ArgumentType::Position => "position",
        ArgumentType::Item => "item",
        ArgumentType::Enum => "enum",
    }
}

fn option_type_name(kind: OptionType) -> &'static str {
    match kind {
        OptionType::Boolean => "boolean",
        OptionType::String => "string",
        OptionType::Number => "number",
    }
}

fn display_value(value: &ArgumentValue) -> String {
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
            .map(display_value)
            .collect::<Vec<_>>()
            .join(" "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn parses_typed_arguments_and_enforces_integer_bounds() {
        let parser = ArgumentParser::default();
        let definitions = [
            ArgumentDefinition::new("count", ArgumentType::Number, true)
                .with_constraint(ArgumentConstraint::Integer)
                .with_constraint(ArgumentConstraint::Minimum(1.0))
                .with_constraint(ArgumentConstraint::Maximum(8.0)),
            ArgumentDefinition::new("mode", ArgumentType::Enum, true)
                .with_enum_values(["walk".to_owned(), "fly".to_owned()]),
        ];

        let parsed = parser
            .parse(&raw(&["4", "FLY"]), &definitions, &[])
            .unwrap();
        assert_eq!(
            parsed.args,
            vec![
                ArgumentValue::Number(4.0),
                ArgumentValue::String("fly".to_owned())
            ]
        );
        assert_eq!(
            parser.parse(&raw(&["4.5", "walk"]), &definitions, &[]),
            Err(ArgumentParseError("Must be an integer".to_owned()))
        );
        assert!(parser
            .parse(&raw(&["9", "walk"]), &definitions, &[])
            .is_err());
    }

    #[test]
    fn validates_values_that_were_constructed_without_the_parser() {
        let definitions = [
            ArgumentDefinition::new("count", ArgumentType::Number, true)
                .with_constraint(ArgumentConstraint::Minimum(1.0)),
            ArgumentDefinition::new("mode", ArgumentType::Enum, true)
                .with_enum_values(["walk".to_owned(), "fly".to_owned()]),
        ];
        let parsed = ParsedArguments {
            args: vec![
                ArgumentValue::Number(0.0),
                ArgumentValue::String("hover".to_owned()),
            ],
            ..ParsedArguments::default()
        };

        let validation = ArgumentParser::validate(&parsed, &definitions, &[]);
        assert!(!validation.valid);
        assert_eq!(validation.errors.len(), 2);
    }

    #[test]
    fn parses_flags_defaults_and_unknown_options_without_losing_raw_input() {
        let parser = ArgumentParser::default();
        let definitions = [
            OptionDefinition::new("verbose", OptionType::Boolean, false).with_alias('v'),
            OptionDefinition::new("limit", OptionType::Number, true)
                .with_alias('l')
                .with_default(ArgumentValue::Number(10.0)),
        ];
        let parsed = parser
            .parse(
                &raw(&["-v", "--limit", "3", "--unknown", "target"]),
                &[],
                &definitions,
            )
            .unwrap();

        assert_eq!(parsed.options["verbose"], ArgumentValue::Boolean(true));
        assert_eq!(parsed.options["limit"], ArgumentValue::Number(3.0));
        assert_eq!(
            parsed.args,
            vec![
                ArgumentValue::String("--unknown".to_owned()),
                ArgumentValue::String("target".to_owned())
            ]
        );
        assert_eq!(
            parsed.raw,
            raw(&["-v", "--limit", "3", "--unknown", "target"])
        );
        assert!(parser
            .parse(&raw(&["--limit", "bad"]), &[], &definitions)
            .is_err());
    }

    #[test]
    fn parses_short_option_bundles_and_applies_option_defaults() {
        let parser = ArgumentParser::default();
        let definitions = [
            OptionDefinition::new("all", OptionType::Boolean, false).with_alias('a'),
            OptionDefinition::new("quiet", OptionType::Boolean, false).with_alias('q'),
            OptionDefinition::new("limit", OptionType::Number, true)
                .with_default(ArgumentValue::Number(5.0)),
        ];
        let parsed = parser.parse(&raw(&["-aq"]), &[], &definitions).unwrap();
        assert_eq!(parsed.options["all"], ArgumentValue::Boolean(true));
        assert_eq!(parsed.options["quiet"], ArgumentValue::Boolean(true));
        assert_eq!(parsed.options["limit"], ArgumentValue::Number(5.0));
    }

    #[test]
    fn parses_greedy_values_and_reports_missing_required_arguments() {
        let parser = ArgumentParser::default();
        let definitions = [ArgumentDefinition::new("message", ArgumentType::String, true).greedy()];
        let parsed = parser
            .parse(&raw(&["hello", "there"]), &definitions, &[])
            .unwrap();
        assert_eq!(
            parsed.args,
            vec![ArgumentValue::List(vec![
                ArgumentValue::String("hello".to_owned()),
                ArgumentValue::String("there".to_owned())
            ])]
        );
        assert!(parser.parse(&[], &definitions, &[]).is_err());
    }

    #[test]
    fn resolves_players_and_items_only_when_lookup_context_is_available() {
        let parser = ArgumentParser::new(ArgumentContext {
            online_players: Some(vec!["Alex".to_owned()]),
            item_names: Some(vec![
                "diamond_sword".to_owned(),
                "diamond_pickaxe".to_owned(),
            ]),
            current_position: None,
        });
        assert_eq!(
            parser
                .parse_value(
                    "alex",
                    &ArgumentDefinition::new("player", ArgumentType::Player, true)
                )
                .unwrap(),
            ArgumentValue::Player("Alex".to_owned())
        );
        assert_eq!(
            parser
                .parse_value(
                    "sword",
                    &ArgumentDefinition::new("item", ArgumentType::Item, true)
                )
                .unwrap(),
            ArgumentValue::Item("diamond_sword".to_owned())
        );
        assert!(parser
            .parse_value(
                "diamond",
                &ArgumentDefinition::new("item", ArgumentType::Item, true)
            )
            .unwrap_err()
            .0
            .starts_with("Ambiguous item"));
        assert!(ArgumentParser::default()
            .parse_value(
                "Alex",
                &ArgumentDefinition::new("player", ArgumentType::Player, true)
            )
            .is_ok());
    }

    #[test]
    fn parses_absolute_and_relative_positions_and_rejects_bad_coordinates() {
        let parser = ArgumentParser::new(ArgumentContext {
            current_position: Some(Position {
                x: 10.0,
                y: 64.0,
                z: -2.0,
            }),
            ..ArgumentContext::default()
        });
        let definition = ArgumentDefinition::new("position", ArgumentType::Position, true);
        assert_eq!(
            parser.parse_value("1, 2, 3", &definition).unwrap(),
            ArgumentValue::Position(Position {
                x: 1.0,
                y: 2.0,
                z: 3.0
            })
        );
        assert_eq!(
            parser.parse_value("~1 ~ ~-3", &definition).unwrap(),
            ArgumentValue::Position(Position {
                x: 11.0,
                y: 64.0,
                z: -5.0
            })
        );
        assert!(parser.parse_value("~ ~ ~", &definition).is_ok());
        assert!(ArgumentParser::default()
            .parse_value("~ ~ ~", &definition)
            .is_err());
        assert!(parser.parse_value("1 2 nope", &definition).is_err());
    }

    #[test]
    fn supplies_suggestions_and_help_formats() {
        let parser = ArgumentParser::new(ArgumentContext {
            online_players: Some(vec!["Alex".to_owned(), "Ari".to_owned()]),
            ..ArgumentContext::default()
        });
        let player = ArgumentDefinition::new("player", ArgumentType::Player, true);
        assert_eq!(parser.get_suggestions("a", &player), ["Alex", "Ari"]);
        assert_eq!(ArgumentParser::format_argument(&player), "<player: player>");
        assert_eq!(
            ArgumentParser::format_option(
                &OptionDefinition::new("limit", OptionType::Number, true).with_alias('l')
            ),
            "--limit, -l <number>"
        );
    }
}
