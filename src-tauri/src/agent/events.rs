//! One vocabulary for everything an agent says during a turn, whichever agent
//! it is, so the panel never has to learn which one it is talking to.
//!
//! Serialized straight off the enum, so the fields arrive in TypeScript in
//! snake_case (`stop_reason`), unlike the rest of the app's IPC. That is
//! deliberate and `src/lib/ai/protocol.ts` says so.

use serde::Serialize;
use serde_json::Value;

use super::errors::ErrorKind;
use super::rpc::Inbound;

/// Sent by the harness itself, through the same channel as the agent's own
/// words, when a turn ends. ACP has no "done" notification - the turn is over
/// when the prompt is answered - and a "done" sent any other way could arrive
/// before the last word.
pub(crate) const TURN_FINISHED: &str = "nuza/turn_finished";
/// The same, for a turn that ended in an error.
pub(crate) const TURN_FAILED: &str = "nuza/turn_failed";
/// Something the harness has to say about the turn that is not the agent's:
/// that it started a fresh conversation, that it moved to another model.
pub(crate) const TURN_NOTICE: &str = "nuza/notice";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum AgentEvent {
    /// Words of the answer.
    Token { text: String },
    /// The model's reasoning, shown folded away.
    Thought { text: String },
    /// A step the agent is taking. An update can leave out whatever has not
    /// changed, so everything but the id is optional and the panel merges.
    Step {
        id: String,
        title: Option<String>,
        status: Option<String>,
    },
    /// The agent's own to-do list for the turn.
    Plan { entries: Vec<PlanEntry> },
    /// How much of the model's context window is in use.
    Usage { used: u64, size: u64 },
    /// The agent asked to do something nuza does not allow, and was told no.
    /// `action` finishes "nuza didn't let the agent …".
    Refused { action: String },
    /// A line from nuza about the turn.
    Notice { text: String },
    /// The turn is over. `stop_reason` is the agent's: `end_turn`,
    /// `cancelled`, `refusal`, `max_tokens`.
    Done { stop_reason: String },
    /// The turn ended in an error.
    Failed { code: ErrorKind, message: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct PlanEntry {
    pub(crate) content: String,
    pub(crate) status: String,
}

/// The session a message is about, if it names one.
pub(crate) fn session_of(message: &Inbound) -> Option<&str> {
    message.params.get("sessionId").and_then(Value::as_str)
}

/// What a message from the agent (or from the harness about it) means to the
/// panel, if anything. Most notifications mean nothing to it: an agent's
/// commands, its title for the chat, its account and its bill are dropped
/// here and go no further.
pub(crate) fn event_of(message: &Inbound) -> Option<AgentEvent> {
    let params = &message.params;
    let text_at = |key: &str| params.get(key).and_then(Value::as_str).map(str::to_string);
    match message.method.as_str() {
        TURN_FINISHED => Some(AgentEvent::Done {
            stop_reason: text_at("stopReason").unwrap_or_else(|| "end_turn".to_string()),
        }),
        TURN_FAILED => Some(AgentEvent::Failed {
            code: serde_json::from_value(params.get("code")?.clone()).ok()?,
            message: text_at("message")?,
        }),
        TURN_NOTICE => Some(AgentEvent::Notice {
            text: text_at("text")?,
        }),
        "session/update" => update_event(params.get("update")?),
        "session/request_permission" => Some(AgentEvent::Refused {
            action: refused_action(params.get("toolCall")),
        }),
        // Anything else the agent asked of nuza - a file, a terminal - which
        // was answered "not supported" and is said so here.
        method if method.starts_with("fs/write") => Some(refused("change a file")),
        method if method.starts_with("fs/") => Some(refused("read a file")),
        method if method.starts_with("terminal/") => Some(refused("run a command")),
        _ => None,
    }
}

fn refused(action: &str) -> AgentEvent {
    AgentEvent::Refused {
        action: action.to_string(),
    }
}

fn update_event(update: &Value) -> Option<AgentEvent> {
    let text = || -> Option<String> {
        let content = update.get("content")?;
        (content.get("type")?.as_str()? == "text").then_some(())?;
        Some(content.get("text")?.as_str()?.to_string())
    };
    let string_at = |key: &str| update.get(key).and_then(Value::as_str).map(str::to_string);

    match update.get("sessionUpdate")?.as_str()? {
        "agent_message_chunk" => Some(AgentEvent::Token { text: text()? }),
        "agent_thought_chunk" => Some(AgentEvent::Thought { text: text()? }),
        "tool_call" | "tool_call_update" => Some(AgentEvent::Step {
            id: string_at("toolCallId")?,
            title: string_at("title"),
            status: string_at("status"),
        }),
        "plan" => Some(AgentEvent::Plan {
            entries: update
                .get("entries")?
                .as_array()?
                .iter()
                .filter_map(|entry| {
                    Some(PlanEntry {
                        content: entry.get("content")?.as_str()?.to_string(),
                        status: entry
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("pending")
                            .to_string(),
                    })
                })
                .collect(),
        }),
        "usage_update" => Some(AgentEvent::Usage {
            used: update.get("used")?.as_u64()?,
            size: update.get("size")?.as_u64()?,
        }),
        _ => None,
    }
}

/// What the agent was stopped from doing, in words: "run a command", not
/// "execute".
fn refused_action(call: Option<&Value>) -> String {
    let kind = call
        .and_then(|call| call.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let action = match kind {
        "edit" => "change a file",
        "delete" => "delete a file",
        "move" => "move a file",
        "execute" => "run a command",
        "fetch" => "look something up on the web",
        "read" => "read a file",
        "search" => "search your files",
        "switch_mode" => "change what it is allowed to do",
        _ => "",
    };
    if !action.is_empty() {
        return action.to_string();
    }
    match call
        .and_then(|call| call.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
    {
        Some(title) => format!("use “{}”", title.chars().take(80).collect::<String>()),
        None => "do that".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inbound(method: &str, params: Value) -> Inbound {
        Inbound {
            method: method.to_string(),
            params,
        }
    }

    fn update(body: Value) -> Option<AgentEvent> {
        event_of(&inbound(
            "session/update",
            json!({ "sessionId": "s", "update": body }),
        ))
    }

    #[test]
    fn words_and_thoughts_are_told_apart() {
        assert_eq!(
            update(
                json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Hi" } })
            ),
            Some(AgentEvent::Token { text: "Hi".into() })
        );
        assert_eq!(
            update(
                json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "Hm" } })
            ),
            Some(AgentEvent::Thought { text: "Hm".into() })
        );
        // A chunk that is not text - an image, a resource - is not words.
        assert_eq!(
            update(
                json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "image", "data": "" } })
            ),
            None
        );
    }

    #[test]
    fn a_step_update_carries_only_what_changed() {
        assert_eq!(
            update(
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed" })
            ),
            Some(AgentEvent::Step {
                id: "t1".into(),
                title: None,
                status: Some("completed".into())
            })
        );
    }

    #[test]
    fn what_the_panel_has_no_use_for_goes_no_further() {
        for body in [
            json!({ "sessionUpdate": "available_commands_update", "availableCommands": [] }),
            json!({ "sessionUpdate": "config_option_update", "configOptions": [] }),
            json!({ "sessionUpdate": "session_info_update", "title": "Chat" }),
        ] {
            assert_eq!(update(body), None);
        }
        let account = inbound(
            "_auth/status_update",
            json!({ "authStatus": { "account": { "email": "someone@example.com" } } }),
        );
        assert_eq!(event_of(&account), None);
    }

    #[test]
    fn a_refusal_says_what_was_not_done() {
        let asked = |call: Value| {
            event_of(&inbound(
                "session/request_permission",
                json!({ "toolCall": call }),
            ))
        };
        assert_eq!(
            asked(json!({ "kind": "execute", "title": "rm -rf ~" })),
            Some(refused("run a command"))
        );
        assert_eq!(
            asked(json!({ "kind": "other", "title": "Approve Plan" })),
            Some(refused("use “Approve Plan”"))
        );
        assert_eq!(asked(json!({})), Some(refused("do that")));
        assert_eq!(
            event_of(&inbound("fs/write_text_file", json!({}))),
            Some(refused("change a file"))
        );
        assert_eq!(
            event_of(&inbound("terminal/create", json!({}))),
            Some(refused("run a command"))
        );
    }

    #[test]
    fn the_harness_ends_a_turn_through_the_same_door() {
        let done = event_of(&inbound(
            TURN_FINISHED,
            json!({ "sessionId": "s", "stopReason": "cancelled" }),
        ));
        assert_eq!(
            done,
            Some(AgentEvent::Done {
                stop_reason: "cancelled".into()
            })
        );
        let failed = event_of(&inbound(
            TURN_FAILED,
            json!({ "sessionId": "s", "code": "timeout", "message": "gave up" }),
        ));
        assert_eq!(
            failed,
            Some(AgentEvent::Failed {
                code: ErrorKind::Timeout,
                message: "gave up".into()
            })
        );
    }

    #[test]
    fn events_reach_the_panel_in_snake_case() {
        let json = serde_json::to_value(AgentEvent::Done {
            stop_reason: "end_turn".into(),
        })
        .unwrap();
        assert_eq!(json, json!({ "kind": "done", "stop_reason": "end_turn" }));
        let json = serde_json::to_value(AgentEvent::Failed {
            code: ErrorKind::NotSignedIn,
            message: "x".into(),
        })
        .unwrap();
        assert_eq!(json["code"], "not_signed_in");
    }
}
