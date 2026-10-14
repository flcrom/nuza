//! The agent, as the webview can reach it.
//!
//! The webview is not trusted here any more than anywhere else. It names an
//! agent from Settings; it never hands over a program to run, a working
//! directory, a sandbox rule or another window's vault. The window a command
//! came from is Tauri's word, not the webview's, and its vault is looked up
//! from that. And the two commands that widen what can happen to a note -
//! starting an agent nobody has agreed to, letting it onto the web - ask the
//! person first, in a native dialog the webview cannot answer for them.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use super::config::AgentConfig;
use super::errors::AgentError;
use super::events::AgentEvent;
use super::harness::{AgentHarness, Emit, ModelInfo, Question};
use super::status::{self, Detection};
use super::store::Store;
use crate::state::Windows;
use crate::tasks::wait_for_picker;

/// Where the AI settings stand, for the window asking.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentState {
    pub(crate) agent: Option<AgentConfig>,
    /// What to call it: "Claude Code", or a custom program's name.
    pub(crate) label: Option<String>,
    /// Whether this computer fences the agent in.
    pub(crate) sandboxed: bool,
    /// Whether the agent may look things up on the web for this window's
    /// vault.
    pub(crate) web_lookups: bool,
    /// Whether this window has a vault open at all.
    pub(crate) has_vault: bool,
}

fn vault_of(window: &WebviewWindow) -> Option<PathBuf> {
    window.state::<Windows>().root(window.label())
}

async fn merged_path() -> std::ffi::OsString {
    tauri::async_runtime::spawn_blocking(crate::shellpath::path)
        .await
        .unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

/// Asks the person, natively, and waits for the answer.
async fn confirm(window: &WebviewWindow, title: String, body: String, yes: &str) -> bool {
    let yes = yes.to_string();
    wait_for_picker(|send| {
        window
            .dialog()
            .message(body)
            .title(title)
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                yes,
                "Cancel".to_string(),
            ))
            .parent(window)
            .show(move |agreed| send(Ok(agreed)));
    })
    .await
    .unwrap_or(false)
}

/// The one-time notice in front of starting an agent. The line about the
/// sandbox is the honest one for this computer, and is not softened where
/// the answer is no.
pub(crate) fn consent_notice(config: &AgentConfig, sandboxed: bool) -> (String, String) {
    let name = config.label();
    let fence = if sandboxed {
        "It runs fenced in: it sees only what nuza sends it, and cannot change your notes or any of your files. Anything beyond that is refused."
    } else {
        "This computer can't fence it in, so it runs with your own permissions."
    };
    let mut body = format!(
        "nuza starts it on this computer and sends it your questions, the text you select, and the note text it needs to answer.\n\n\
         It is not made by nuza. Its sign-in, its usage limits and what it does with your data are set by its own provider.\n\n\
         {fence}"
    );
    if let AgentConfig::Custom { command, args, .. } = config {
        let line = std::iter::once(command.trim())
            .chain(args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ");
        body.push_str(&format!("\n\nIt will run:\n{line}"));
    }
    (format!("Turn on {name}?"), body)
}

#[tauri::command]
pub(crate) fn agent_state(
    window: WebviewWindow,
    harness: State<'_, Arc<AgentHarness>>,
    store: State<'_, Store>,
) -> AgentState {
    let agent = harness.current();
    let vault = vault_of(&window);
    AgentState {
        label: agent.as_ref().map(AgentConfig::label),
        agent,
        sandboxed: super::start::sandboxed(),
        web_lookups: vault
            .as_deref()
            .is_some_and(|vault| store.web_lookups(vault)),
        has_vault: vault.is_some(),
    }
}

/// What is installed. Runs local programs only, and contacts nothing.
#[tauri::command]
pub(crate) async fn agent_detect() -> Detection {
    status::detect(&merged_path().await).await
}

/// Where a custom agent's command is, if it is anywhere.
#[tauri::command]
pub(crate) async fn agent_find_command(command: String) -> Option<String> {
    status::resolve_command(&command, &merged_path().await)
        .map(|at| at.to_string_lossy().into_owned())
}

/// Turns `config`'s agent on and starts it. Returns false if the person
/// would rather not after all.
#[tauri::command]
pub(crate) async fn agent_use(
    window: WebviewWindow,
    config: AgentConfig,
    harness: State<'_, Arc<AgentHarness>>,
    store: State<'_, Store>,
) -> Result<bool, AgentError> {
    if !store.approved(&config) {
        let (title, body) = consent_notice(&config, super::start::sandboxed());
        if !confirm(&window, title, body, "Turn On").await {
            return Ok(false);
        }
        store.update(|decisions| decisions.approved.push(config.id()));
    }
    store.update(|decisions| decisions.agent = Some(config.clone()));
    harness.use_agent(config).await?;
    Ok(true)
}

/// Turns AI off: the agent is stopped, and nothing is started again until
/// one is turned on.
#[tauri::command]
pub(crate) async fn agent_turn_off(
    harness: State<'_, Arc<AgentHarness>>,
    store: State<'_, Store>,
) -> Result<(), String> {
    store.update(|decisions| decisions.agent = None);
    harness.set_agent(None).await;
    Ok(())
}

/// Starts the agent ahead of the first question.
#[tauri::command]
pub(crate) async fn agent_warm(harness: State<'_, Arc<AgentHarness>>) -> Result<(), AgentError> {
    harness.warm().await
}

#[tauri::command]
pub(crate) async fn agent_list_models(
    harness: State<'_, Arc<AgentHarness>>,
) -> Result<Vec<ModelInfo>, AgentError> {
    harness.list_models().await
}

/// Asks the agent something in this window's conversation. What it says
/// arrives on `on_event`, ending with `done` or `failed`. `in_full` is the
/// same question with the note and the rules, for when the agent turns out
/// not to have the conversation - a new one, or one it lost.
#[tauri::command]
pub(crate) async fn agent_prompt(
    window: WebviewWindow,
    text: String,
    in_full: Option<String>,
    model: Option<String>,
    on_event: Channel<AgentEvent>,
    harness: State<'_, Arc<AgentHarness>>,
) -> Result<(), String> {
    let emit: Emit = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    let vault = vault_of(&window);
    // The outcome has gone down the channel already, as the turn's last event.
    let _ = harness
        .prompt(
            window.label(),
            vault.as_deref(),
            Question {
                text: &text,
                in_full: in_full.as_deref(),
            },
            model.as_deref(),
            emit,
        )
        .await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn agent_cancel(
    window: WebviewWindow,
    harness: State<'_, Arc<AgentHarness>>,
) -> Result<(), String> {
    harness.cancel(window.label()).await
}

#[tauri::command]
pub(crate) async fn agent_new_chat(
    window: WebviewWindow,
    harness: State<'_, Arc<AgentHarness>>,
) -> Result<(), String> {
    harness.new_chat(window.label()).await;
    Ok(())
}

/// Starts `codex login`, which opens a browser of its own.
#[tauri::command]
pub(crate) async fn agent_login() -> Result<(), String> {
    status::codex_login(&merged_path().await)
}

/// Lets the agent look things up on the web for this window's vault, or
/// stops it. Turning it on is asked about first.
#[tauri::command]
pub(crate) async fn agent_set_web_lookups(
    window: WebviewWindow,
    allowed: bool,
    harness: State<'_, Arc<AgentHarness>>,
    store: State<'_, Store>,
) -> Result<bool, String> {
    let vault = vault_of(&window).ok_or("Open a folder first")?;
    if allowed && !store.web_lookups(&vault) {
        let name = harness
            .current()
            .map_or_else(|| "The agent".to_string(), |agent| agent.label());
        let body = format!(
            "For the notes in this folder, {name} will be allowed to fetch web pages when it asks.\n\n\
             A note can hold text written to talk an agent into things - a pasted article, a file someone shared. \
             With this on, a note like that could have {name} send what it has read to a website.\n\n\
             Leave it off unless you need it."
        );
        let title = "Let the agent look things up on the web?".to_string();
        if !confirm(&window, title, body, "Allow").await {
            return Ok(false);
        }
    }
    store.update(|decisions| {
        decisions.web_vaults.retain(|kept| kept != &vault);
        if allowed {
            decisions.web_vaults.push(vault.clone());
        }
    });
    harness.set_web_lookups(&vault, allowed);
    Ok(allowed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_notice_says_plainly_when_the_agent_is_not_fenced_in() {
        let (title, fenced) = consent_notice(&AgentConfig::ClaudeCode, true);
        assert_eq!(title, "Turn on Claude Code?");
        assert!(fenced.contains("fenced in"));
        let (_, open) = consent_notice(&AgentConfig::ClaudeCode, false);
        assert!(
            open.contains("This computer can't fence it in, so it runs with your own permissions.")
        );
        assert!(!open.contains("fenced in:"));
    }

    #[test]
    fn a_custom_agent_is_agreed_to_with_its_whole_command_in_view() {
        let custom = AgentConfig::Custom {
            command: "node".into(),
            args: vec!["~/agents/mine.js".into(), "--acp".into()],
            data_dirs: vec![],
        };
        let (title, body) = consent_notice(&custom, true);
        assert_eq!(title, "Turn on node?");
        assert!(
            body.ends_with("It will run:\nnode ~/agents/mine.js --acp"),
            "{body}"
        );
    }
}
