//! What went wrong with the agent, as something the panel can act on: a kind,
//! so the right fix can be put in reach, and a message that names the agent
//! the person actually runs.
//!
//! Agents give no structured error codes for any of this, so the kind is read
//! from the wording. That is unlovely, and still better than showing a writer
//! a raw adapter error - and what cannot be sorted is passed through exactly
//! as the agent said it, because the agent's own words beat a wrong guess.

use serde::{Deserialize, Serialize};

use super::config::AgentConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ErrorKind {
    /// No agent is turned on.
    Off,
    /// The program is not there, or would not start.
    AgentMissing,
    /// The agent has no sign-in.
    NotSignedIn,
    /// The person's own plan is used up for now.
    UsageLimit,
    /// Their plan cannot use the model that was asked for.
    ModelUnavailable,
    /// The agent stopped in the middle of things.
    AdapterCrashed,
    /// The agent went quiet and was given up on.
    Timeout,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct AgentError {
    pub(crate) kind: ErrorKind,
    pub(crate) message: String,
}

impl AgentError {
    pub(crate) fn other(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Other,
            message: message.into(),
        }
    }

    pub(crate) fn off() -> Self {
        Self {
            kind: ErrorKind::Off,
            message: "No agent is turned on. Choose one in Settings, under AI.".to_string(),
        }
    }
}

/// What a raw error from an agent - or from talking to it - means. The order
/// of the checks is part of the answer: "sign in again once your usage limit
/// resets" is a limit, not a sign-in problem.
pub(crate) fn classify(raw: &str, agent: &AgentConfig) -> AgentError {
    let lower = raw.to_lowercase();
    let says = |words: &[&str]| words.iter().any(|word| lower.contains(word));
    let name = agent.label();

    let (kind, message) = if says(&["usage limit", "rate limit", "quota", "too many requests"]) {
        (
            ErrorKind::UsageLimit,
            format!("You've hit {name}'s usage limit. Try again once it resets."),
        )
    } else if says(&["stopped responding"]) {
        (
            ErrorKind::Timeout,
            format!("{name} stopped responding, so nuza gave up on this answer."),
        )
    } else if says(&[
        "model is not supported",
        "model is not available",
        "not supported when using",
    ]) {
        (
            ErrorKind::ModelUnavailable,
            "Your plan can't use that model. Pick another one.".to_string(),
        )
    } else if says(&[
        "unauthorized",
        "unauthorised",
        "not logged in",
        "log in",
        "login required",
        "sign in",
        "signed in",
        "authenticat",
    ]) {
        (ErrorKind::NotSignedIn, not_signed_in(agent))
    } else if says(&["exited", "closed before responding", "broken pipe"]) {
        let said = last_words(raw);
        (
            ErrorKind::AdapterCrashed,
            match said {
                Some(said) => {
                    format!("{name} stopped unexpectedly. Retry restarts it. It said: {said}")
                }
                None => format!("{name} stopped unexpectedly. Retry restarts it."),
            },
        )
    } else if says(&[
        "could not start",
        "no such file",
        "command not found",
        "not installed",
        "enoent",
    ]) {
        (ErrorKind::AgentMissing, missing(agent))
    } else {
        (ErrorKind::Other, raw.to_string())
    };
    AgentError { kind, message }
}

fn not_signed_in(agent: &AgentConfig) -> String {
    let name = agent.label();
    match agent {
        AgentConfig::ClaudeCode => {
            format!("{name} isn't signed in. Run `claude` once in a terminal and sign in.")
        }
        AgentConfig::Codex => format!("{name} isn't signed in. Run `codex login`."),
        AgentConfig::OpenCode => format!("{name} isn't signed in. Run `opencode auth login`."),
        AgentConfig::Custom { .. } => format!("{name} isn't signed in."),
    }
}

fn missing(agent: &AgentConfig) -> String {
    let name = agent.label();
    if agent.needs_node() {
        format!(
            "Couldn't start {name}. It needs Node.js 22 or newer - install it, or launch nuza from a terminal."
        )
    } else {
        format!("Couldn't start {name}. Check that it is installed.")
    }
}

/// The last thing the agent printed before it went, from the error
/// `rpc.rs` builds: "agent process exited: <line> | <line>".
fn last_words(raw: &str) -> Option<&str> {
    let (_, said) = raw.split_once("exited: ")?;
    said.rsplit(" | ")
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(raw: &str) -> ErrorKind {
        classify(raw, &AgentConfig::Codex).kind
    }

    #[test]
    fn the_errors_agents_actually_give_are_sorted() {
        assert_eq!(
            kind("You've hit your usage limit. Try again in 3 hours."),
            ErrorKind::UsageLimit
        );
        assert_eq!(kind("429 Too Many Requests"), ErrorKind::UsageLimit);
        assert_eq!(kind("not logged in"), ErrorKind::NotSignedIn);
        assert_eq!(kind("401 Unauthorized"), ErrorKind::NotSignedIn);
        assert_eq!(kind("Authentication required"), ErrorKind::NotSignedIn);
        assert_eq!(kind("agent process exited"), ErrorKind::AdapterCrashed);
        assert_eq!(
            kind("the agent closed before responding"),
            ErrorKind::AdapterCrashed
        );
        assert_eq!(
            kind("could not start Codex: npx was not found"),
            ErrorKind::AgentMissing
        );
        assert_eq!(
            kind(
                "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."
            ),
            ErrorKind::ModelUnavailable
        );
        assert_eq!(
            kind("The agent stopped responding (nothing for 180 seconds)."),
            ErrorKind::Timeout
        );
    }

    #[test]
    fn a_limit_beats_the_wording_of_a_sign_in() {
        assert_eq!(
            kind("usage limit reached, sign in again later"),
            ErrorKind::UsageLimit
        );
    }

    #[test]
    fn a_session_the_agent_lost_is_not_a_missing_agent() {
        assert_eq!(kind("Internal error: Session not found"), ErrorKind::Other);
    }

    #[test]
    fn every_message_names_the_agent_in_use() {
        let claude = classify("not logged in", &AgentConfig::ClaudeCode);
        assert!(
            claude.message.starts_with("Claude Code isn't signed in"),
            "{}",
            claude.message
        );
        let custom = AgentConfig::Custom {
            command: "/opt/bin/my-agent".into(),
            args: vec![],
            data_dirs: vec![],
        };
        assert!(classify("agent process exited", &custom)
            .message
            .starts_with("my-agent stopped"));
        assert!(classify("usage limit", &AgentConfig::OpenCode)
            .message
            .contains("OpenCode's"));
    }

    #[test]
    fn a_crash_passes_on_what_the_agent_last_said() {
        let crashed = classify(
            "agent process exited: npm error code EACCES | npm error path /x",
            &AgentConfig::ClaudeCode,
        );
        assert!(
            crashed.message.ends_with("It said: npm error path /x"),
            "{}",
            crashed.message
        );
    }

    #[test]
    fn an_agent_that_needs_node_says_so_when_it_will_not_start() {
        let message = classify("could not start", &AgentConfig::ClaudeCode).message;
        assert!(message.contains("Node.js"), "{message}");
        let message = classify("could not start", &AgentConfig::OpenCode).message;
        assert!(!message.contains("Node.js"), "{message}");
    }

    #[test]
    fn what_cannot_be_sorted_is_passed_on_word_for_word() {
        let error = classify(
            "the network is unreachable (os error 51)",
            &AgentConfig::Codex,
        );
        assert_eq!(
            error,
            AgentError::other("the network is unreachable (os error 51)")
        );
    }
}
