//! The ACP client against `scripts/mock-acp-agent.mjs`, which plays each of
//! the agents nuza supports the way `docs/acp-transcript.md` recorded them.
//! No agent, account or network is needed - only Node, which runs the mock.
//!
//! The tests named `real_*` talk to a real agent instead, and are ignored
//! unless asked for: they need it installed and signed in, and they spend a
//! little of its plan.
//!
//! ```sh
//! cargo test real_claude -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::timeout;

use super::rpc::{Inbound, RefuseAll, RpcClient};

fn mock_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri sits in the repository")
        .join("scripts/mock-acp-agent.mjs")
}

fn mock(flavor: &str) -> Command {
    let mut command = Command::new("node");
    command.arg(mock_script()).args(["--flavor", flavor]);
    command
}

struct Agent {
    client: RpcClient,
    inbound: mpsc::UnboundedReceiver<Inbound>,
}

fn start(command: Command) -> Agent {
    let (sender, inbound) = mpsc::unbounded_channel();
    let client = RpcClient::spawn(command, sender, std::sync::Arc::new(RefuseAll))
        .expect("node runs the mock agent");
    Agent { client, inbound }
}

/// Starts the mock, says hello, and opens a session it will answer in.
async fn session(flavor: &str) -> (Agent, String) {
    let agent = start(mock(flavor));
    agent
        .client
        .request(
            "initialize",
            json!({ "protocolVersion": 1, "clientCapabilities": {} }),
        )
        .await
        .expect("the mock says hello back");
    let cwd = tempfile::tempdir().unwrap();
    let opened = agent
        .client
        .request(
            "session/new",
            json!({ "cwd": cwd.path(), "mcpServers": [] }),
        )
        .await
        .expect("a session opens");
    let id = opened["sessionId"].as_str().unwrap().to_string();
    // The one flavour that will not answer until it is read-only - and which,
    // like a real Codex whose config has drifted, starts on a model the plan
    // does not cover. Moving off it is the harness's job; here it is done by
    // hand.
    if flavor == "codex" {
        agent
            .client
            .request(
                "session/set_mode",
                json!({ "sessionId": id, "modeId": "read-only" }),
            )
            .await
            .unwrap();
        agent
            .client
            .request(
                "session/set_model",
                json!({ "sessionId": id, "modelId": "current[low]" }),
            )
            .await
            .unwrap();
    }
    (agent, id)
}

async fn prompt(agent: &Agent, session: &str, text: &str) -> Result<Value, String> {
    timeout(
        Duration::from_secs(10),
        agent.client.request(
            "session/prompt",
            json!({ "sessionId": session, "prompt": [{ "type": "text", "text": text }] }),
        ),
    )
    .await
    .expect("the turn ends")
}

/// Everything the agent has said so far, without waiting for more.
fn heard(agent: &mut Agent) -> Vec<Inbound> {
    let mut all = Vec::new();
    while let Ok(message) = agent.inbound.try_recv() {
        all.push(message);
    }
    all
}

/// The words of the answer, in the order they came.
fn answer(messages: &[Inbound]) -> String {
    messages
        .iter()
        .filter(|m| m.method == "session/update")
        .filter(|m| m.params["update"]["sessionUpdate"] == "agent_message_chunk")
        .filter_map(|m| m.params["update"]["content"]["text"].as_str())
        .collect()
}

#[tokio::test]
async fn a_request_is_answered_by_its_own_id() {
    let agent = start(mock("codex"));
    let hello = agent
        .client
        .request(
            "initialize",
            json!({ "protocolVersion": 1, "clientCapabilities": {} }),
        )
        .await
        .unwrap();
    assert_eq!(hello["protocolVersion"], 1);
    assert_eq!(hello["agentCapabilities"]["mcpCapabilities"]["http"], true);
}

#[tokio::test]
async fn the_protocol_version_is_a_number() {
    let agent = start(mock("claude"));
    let refused = agent
        .client
        .request(
            "initialize",
            json!({ "protocolVersion": "1", "clientCapabilities": {} }),
        )
        .await
        .unwrap_err();
    assert!(refused.contains("must be a number"), "{refused}");
}

#[tokio::test]
async fn a_session_needs_its_mcp_servers_even_when_there_are_none() {
    let agent = start(mock("codex"));
    agent
        .client
        .request(
            "initialize",
            json!({ "protocolVersion": 1, "clientCapabilities": {} }),
        )
        .await
        .unwrap();
    let refused = agent
        .client
        .request("session/new", json!({ "cwd": "/tmp" }))
        .await
        .unwrap_err();
    assert!(refused.contains("mcpServers is required"), "{refused}");
}

#[tokio::test]
async fn every_word_has_arrived_by_the_time_the_turn_ends() {
    for flavor in ["codex", "claude", "opencode"] {
        let (mut agent, id) = session(flavor).await;
        let ended = prompt(&agent, &id, "hello there").await.unwrap();
        assert_eq!(ended["stopReason"], "end_turn");
        // There is no "done" notification: the turn is over when the prompt
        // is answered, and by then every chunk before it has been read.
        assert_eq!(
            answer(&heard(&mut agent)),
            "You said: hello there",
            "{flavor}"
        );
    }
}

#[tokio::test]
async fn a_permission_is_asked_for_answered_and_refused() {
    let (mut agent, id) = session("claude").await;
    prompt(&agent, &id, "PERMISSION please").await.unwrap();

    let messages = heard(&mut agent);
    assert_eq!(answer(&messages), "permission outcome: cancelled/-");
    // And the refusal is passed on, so it can be shown rather than hidden.
    assert!(messages
        .iter()
        .any(|m| m.method == "session/request_permission"
            && m.params["toolCall"]["title"] == "Write hello.txt"));
}

#[tokio::test]
async fn asking_for_a_file_is_asking_for_a_method_nuza_does_not_have() {
    let (mut agent, id) = session("codex").await;
    prompt(&agent, &id, "ASK_FS").await.unwrap();
    assert_eq!(answer(&heard(&mut agent)), "fs answer: -32601");
}

#[tokio::test]
async fn an_internal_error_comes_with_its_reason() {
    let (agent, id) = session("claude").await;
    let refused = agent
        .client
        .request(
            "session/set_mode",
            json!({ "sessionId": id, "modeId": "read-only" }),
        )
        .await
        .unwrap_err();
    assert_eq!(refused, "Internal error: Invalid Mode");
}

#[tokio::test]
async fn lines_that_are_not_the_protocol_are_passed_over() {
    // OpenCode's plugins print on stdout; the conversation carries on.
    let (mut agent, id) = session("opencode").await;
    prompt(&agent, &id, "NOISE then words").await.unwrap();
    let messages = heard(&mut agent);
    assert_eq!(answer(&messages), "You said: NOISE then words");
    // Notifications nuza has no use for still arrive; ignoring them is the
    // harness's business, not the wire's.
    assert!(messages.iter().any(|m| m.method == "_auth/status_update"));
}

#[tokio::test]
async fn an_agent_that_dies_fails_what_was_waiting_with_its_last_words() {
    let (agent, id) = session("codex").await;
    let error = prompt(&agent, &id, "CRASH").await.unwrap_err();
    assert!(error.starts_with("agent process exited"), "{error}");
    assert!(error.contains("npm error code EACCES"), "{error}");

    // And it is seen to have gone, which is what tells the harness to start
    // another.
    timeout(Duration::from_secs(5), async {
        while !agent.client.has_exited().await {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the agent is seen to have exited");
}

#[tokio::test]
async fn a_request_to_an_agent_that_has_gone_fails_rather_than_waits() {
    let (agent, id) = session("codex").await;
    let _ = prompt(&agent, &id, "CRASH").await;
    let error = timeout(Duration::from_secs(5), prompt(&agent, &id, "anyone there"))
        .await
        .expect("does not hang")
        .unwrap_err();
    assert!(
        error.contains("could not write") || error.contains("closed before responding"),
        "{error}"
    );
}

#[tokio::test]
async fn cancelling_is_a_notification_and_the_turn_still_ends() {
    let (mut agent, id) = session("codex").await;
    let agent_ref = &agent;
    let running = prompt(agent_ref, &id, "SLOW");
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        agent_ref
            .client
            .notify("session/cancel", json!({ "sessionId": id }))
            .await
            .unwrap();
    };
    let (ended, ()) = tokio::join!(running, cancel);
    assert_eq!(ended.unwrap()["stopReason"], "cancelled");
    // What was said before the cancel is still there.
    let said = answer(&heard(&mut agent));
    assert!(said.contains("word"));
    assert!(said.matches("word").count() < 100, "{said}");
}

#[cfg(unix)]
#[tokio::test]
async fn killing_the_agent_takes_what_it_started_with_it() {
    // A shell that leaves a child behind and then becomes the agent, the way
    // `npx` leaves the adapter running under it.
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("child.pid");
    let mut command = Command::new("sh");
    command.arg("-c").arg(format!(
        "sleep 300 & echo $! > '{}'; exec node '{}' --flavor codex",
        pid_file.display(),
        mock_script().display()
    ));
    let agent = start(command);
    agent
        .client
        .request(
            "initialize",
            json!({ "protocolVersion": 1, "clientCapabilities": {} }),
        )
        .await
        .unwrap();
    let child: libc::pid_t = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();

    agent.client.kill().await;

    let alive = |pid| unsafe { libc::kill(pid, 0) } == 0;
    let gone = timeout(Duration::from_secs(5), async {
        while alive(child) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(gone.is_ok(), "the agent's child {child} is still running");
    assert!(agent.client.has_exited().await);
}

/// The pinned adapter Claude Code is reached through.
const CLAUDE_ADAPTER: &str = "@agentclientprotocol/claude-agent-acp@0.90.0";

/// Opt-in: one real prompt through the real Claude Code, by way of its ACP
/// adapter, printing every message in both directions. The first run pays for
/// `npx` fetching the adapter, which has been seen to take over a minute.
#[tokio::test]
#[ignore]
async fn real_claude_says_hello() {
    let path = tokio::task::spawn_blocking(crate::shellpath::path)
        .await
        .unwrap();
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap();
    let mut command = Command::new("npx");
    command
        .env("PATH", &path)
        .arg("-y")
        .arg("--cache")
        .arg(home.join(".npm/_nuza-claude"))
        .arg(CLAUDE_ADAPTER);
    let mut agent = start(command);

    let started = std::time::Instant::now();
    let hello = timeout(
        Duration::from_secs(300),
        agent.client.request(
            "initialize",
            json!({ "protocolVersion": 1, "clientCapabilities": {} }),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    println!("initialize, after {:?}: {hello}", started.elapsed());

    let cwd = tempfile::tempdir().unwrap();
    let opened = agent
        .client
        .request(
            "session/new",
            json!({ "cwd": cwd.path(), "mcpServers": [] }),
        )
        .await
        .unwrap();
    let id = opened["sessionId"].as_str().unwrap().to_string();
    println!("modes: {}", opened["modes"]);

    let ended = timeout(
        Duration::from_secs(180),
        agent.client.request(
            "session/prompt",
            json!({ "sessionId": id, "prompt": [{ "type": "text", "text": "Say hello in five words or fewer." }] }),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let messages = heard(&mut agent);
    for message in &messages {
        println!("<- {} {}", message.method, message.params);
    }
    println!("stop: {ended}");
    let said = answer(&messages);
    println!("ANSWER: {said}");
    assert!(!said.trim().is_empty());
    agent.client.kill().await;
}

// ---------------------------------------------------------------------------
// The harness: everything a window's conversation goes through
// ---------------------------------------------------------------------------

use std::path::Path;
use std::sync::{Arc, Mutex};

use super::config::AgentConfig;
use super::errors::ErrorKind;
use super::events::AgentEvent;
use super::harness::{AgentHarness, Emit};

/// A harness whose agent is the mock, playing `flavor`, turned on as the
/// agent it plays.
struct Harnessed {
    harness: AgentHarness,
    _root: tempfile::TempDir,
    sessions: std::path::PathBuf,
    _one_at_a_time: Option<tokio::sync::OwnedMutexGuard<()>>,
}

/// On Windows the harness tests take turns. Run side by side, a mock agent
/// that exited was sometimes not seen to have gone - its output pipe held
/// open by another test's agent, started at the same moment - and the turn
/// waited on it until the test gave up. One at a time, every one of them
/// passes; and the app itself only ever runs one agent.
async fn one_at_a_time() -> Option<tokio::sync::OwnedMutexGuard<()>> {
    if !cfg!(windows) {
        return None;
    }
    static TURNS: std::sync::LazyLock<Arc<tokio::sync::Mutex<()>>> =
        std::sync::LazyLock::new(Arc::default);
    Some(Arc::clone(&TURNS).lock_owned().await)
}

async fn harnessed(flavor: &'static str) -> Harnessed {
    let one_at_a_time = one_at_a_time().await;
    let root = tempfile::tempdir().unwrap();
    let sessions = root.path().canonicalize().unwrap().join("sessions");
    let harness = AgentHarness::new(Arc::new(move |_| Ok(mock(flavor))), sessions.clone());
    harness.restore(Some(match flavor {
        "codex" => AgentConfig::Codex,
        "claude" => AgentConfig::ClaudeCode,
        "opencode" => AgentConfig::OpenCode,
        _ => AgentConfig::Custom {
            command: format!("mock-{flavor}"),
            args: vec![],
            data_dirs: vec![],
        },
    }));
    Harnessed {
        harness,
        _root: root,
        sessions,
        _one_at_a_time: one_at_a_time,
    }
}

/// Where a turn's events are collected, in the order the panel would get them.
#[derive(Clone, Default)]
struct Panel(Arc<Mutex<Vec<AgentEvent>>>);

impl Panel {
    fn emit(&self) -> Emit {
        let events = Arc::clone(&self.0);
        Arc::new(move |event| events.lock().unwrap().push(event))
    }

    fn events(&self) -> Vec<AgentEvent> {
        self.0.lock().unwrap().clone()
    }

    fn said(&self) -> String {
        self.events()
            .iter()
            .filter_map(|event| match event {
                AgentEvent::Token { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn last(&self) -> Option<AgentEvent> {
        self.events().last().cloned()
    }
}

async fn ask(
    harness: &AgentHarness,
    window: &str,
    text: &str,
) -> (Panel, Result<String, super::errors::AgentError>) {
    let panel = Panel::default();
    let outcome = timeout(
        Duration::from_secs(20),
        harness.prompt(window, None, text, None, panel.emit()),
    )
    .await
    .expect("the turn ends");
    (panel, outcome)
}

fn done(reason: &str) -> AgentEvent {
    AgentEvent::Done {
        stop_reason: reason.to_string(),
    }
}

#[tokio::test]
async fn streams_tokens_then_done_in_order() {
    for flavor in ["codex", "claude", "opencode"] {
        let h = harnessed(flavor).await;
        let (panel, outcome) = ask(&h.harness, "main", "hello there").await;
        assert_eq!(outcome.unwrap(), "end_turn", "{flavor}");
        assert_eq!(panel.said(), "You said: hello there", "{flavor}");
        assert_eq!(panel.last(), Some(done("end_turn")), "{flavor}");
        h.harness.shutdown().await;
    }
}

#[tokio::test]
async fn done_never_arrives_before_the_last_token() {
    // Nothing between the words and the end is held back on purpose, so a
    // `Done` sent any way but behind them would overtake them here.
    let h = harnessed("claude").await;
    for n in 0..15 {
        let (panel, _) = ask(&h.harness, "main", &format!("turn {n} of many words")).await;
        assert_eq!(panel.said(), format!("You said: turn {n} of many words"));
        assert_eq!(panel.last(), Some(done("end_turn")));
    }
}

#[tokio::test]
async fn each_agent_is_left_in_a_mode_that_asks_before_changing_anything() {
    for (flavor, mode) in [("codex", "read-only"), ("claude", "default")] {
        let h = harnessed(flavor).await;
        let (panel, _) = ask(&h.harness, "main", "WHICH_MODE").await;
        assert_eq!(panel.said(), format!("mode {mode}"), "{flavor}");
    }
    // An agent with no modes at all is still used; the sandbox is what holds.
    let h = harnessed("opencode").await;
    let (panel, outcome) = ask(&h.harness, "main", "hello").await;
    assert!(outcome.is_ok(), "{:?}", panel.events());
}

#[tokio::test]
async fn an_agent_with_no_mode_that_asks_is_not_used() {
    let h = harnessed("reckless").await;
    let (panel, outcome) = ask(&h.harness, "main", "hello").await;
    let error = outcome.unwrap_err();
    assert!(
        error.message.contains("no mode that asks"),
        "{}",
        error.message
    );
    assert!(matches!(panel.last(), Some(AgentEvent::Failed { .. })));
    assert!(panel.said().is_empty());
}

#[tokio::test]
async fn permission_requests_are_denied_and_surfaced() {
    let h = harnessed("claude").await;
    let (panel, _) = ask(&h.harness, "main", "PERMISSION").await;
    assert_eq!(panel.said(), "permission outcome: cancelled/-");
    assert!(panel.events().contains(&AgentEvent::Refused {
        action: "change a file".into()
    }));
    // The step it tried is shown too.
    assert!(panel.events().iter().any(|event| matches!(event,
        AgentEvent::Step { title: Some(title), .. } if title == "Write hello.txt")));
}

#[tokio::test]
async fn asking_for_a_file_or_a_terminal_is_refused_and_said_so() {
    let h = harnessed("codex").await;
    let (panel, _) = ask(&h.harness, "main", "ASK_FS").await;
    assert_eq!(panel.said(), "fs answer: -32601");
    assert!(panel.events().contains(&AgentEvent::Refused {
        action: "read a file".into()
    }));
}

#[tokio::test]
async fn a_web_fetch_is_refused_unless_the_vault_allows_it() {
    let h = harnessed("claude").await;
    let vault = tempfile::tempdir().unwrap();
    let fetch = |panel: &Panel| panel.said();

    let panel = Panel::default();
    h.harness
        .prompt("main", Some(vault.path()), "FETCHCALL", None, panel.emit())
        .await
        .unwrap();
    assert_eq!(fetch(&panel), "call outcome: cancelled/-");
    assert!(panel.events().contains(&AgentEvent::Refused {
        action: "look something up on the web".into()
    }));

    h.harness.set_web_lookups(vault.path(), true);
    let panel = Panel::default();
    h.harness
        .prompt("main", Some(vault.path()), "FETCHCALL", None, panel.emit())
        .await
        .unwrap();
    assert_eq!(fetch(&panel), "call outcome: selected/allow");
    assert!(!panel
        .events()
        .iter()
        .any(|event| matches!(event, AgentEvent::Refused { .. })));

    // Allowed to look things up is not allowed to run things.
    let panel = Panel::default();
    h.harness
        .prompt("main", Some(vault.path()), "RUNCALL", None, panel.emit())
        .await
        .unwrap();
    assert_eq!(fetch(&panel), "call outcome: cancelled/-");

    // And another vault is not this one.
    let other = tempfile::tempdir().unwrap();
    let panel = Panel::default();
    h.harness
        .prompt(
            "second",
            Some(other.path()),
            "FETCHCALL",
            None,
            panel.emit(),
        )
        .await
        .unwrap();
    assert_eq!(fetch(&panel), "call outcome: cancelled/-");
}

#[tokio::test]
async fn thoughts_steps_plans_and_usage_reach_the_panel() {
    let h = harnessed("codex").await;
    let (panel, _) = ask(&h.harness, "main", "RICH").await;
    let events = panel.events();
    assert!(events.contains(&AgentEvent::Thought {
        text: "Let me look.".into()
    }));
    assert!(events.contains(&AgentEvent::Step {
        id: "t1".into(),
        title: Some("Read releases.md".into()),
        status: Some("pending".into())
    }));
    assert!(events.contains(&AgentEvent::Step {
        id: "t1".into(),
        title: None,
        status: Some("completed".into())
    }));
    assert!(events.iter().any(|event| matches!(event,
        AgentEvent::Plan { entries } if entries.len() == 1 && entries[0].status == "in_progress")));
    assert!(events.contains(&AgentEvent::Usage {
        used: 1200,
        size: 200000
    }));
}

#[tokio::test]
async fn what_the_panel_has_no_use_for_never_reaches_it() {
    let h = harnessed("opencode").await;
    let (panel, _) = ask(&h.harness, "main", "NOISE").await;
    assert_eq!(panel.said(), "You said: NOISE");
    // The account update, the agent's commands and the chat's title are all
    // dropped; the usage that came after the words is not.
    for event in panel.events() {
        assert!(
            matches!(
                event,
                AgentEvent::Token { .. } | AgentEvent::Usage { .. } | AgentEvent::Done { .. }
            ),
            "{event:?}"
        );
    }
}

#[tokio::test]
async fn a_hung_turn_is_given_up_on() {
    let h = harnessed("codex").await;
    let harness = h.harness.with_idle_timeout(Duration::from_millis(600));
    let started = std::time::Instant::now();
    let (panel, outcome) = ask(&harness, "main", "STALL").await;
    let error = outcome.unwrap_err();
    assert_eq!(error.kind, ErrorKind::Timeout);
    assert!(
        error.message.starts_with("Codex stopped responding"),
        "{}",
        error.message
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(matches!(
        panel.last(),
        Some(AgentEvent::Failed {
            code: ErrorKind::Timeout,
            ..
        })
    ));

    // The agent itself is fine, and the next question is answered.
    let (panel, _) = ask(&harness, "main", "hello").await;
    assert_eq!(panel.said(), "You said: hello");
}

#[tokio::test]
async fn a_slow_turn_that_keeps_talking_is_not_cut_off() {
    // Four seconds of words in all, never more than 20ms apart.
    let h = harnessed("codex").await;
    let harness = h.harness.with_idle_timeout(Duration::from_millis(500));
    let (panel, outcome) = ask(&harness, "main", "SLOW").await;
    assert_eq!(outcome.unwrap(), "end_turn");
    assert_eq!(panel.said().matches("word").count(), 200);
}

#[tokio::test]
async fn a_crashed_adapter_fails_the_turn_with_its_last_words() {
    let h = harnessed("claude").await;
    let (panel, outcome) = ask(&h.harness, "main", "CRASH").await;
    let error = outcome.unwrap_err();
    assert_eq!(error.kind, ErrorKind::AdapterCrashed);
    assert!(
        error
            .message
            .starts_with("Claude Code stopped unexpectedly"),
        "{}",
        error.message
    );
    assert!(error.message.contains("npm error"), "{}", error.message);
    assert!(matches!(panel.last(), Some(AgentEvent::Failed { .. })));
}

#[tokio::test]
async fn a_crashed_adapter_is_started_again_by_the_next_question() {
    let h = harnessed("claude").await;
    let _ = ask(&h.harness, "main", "CRASH").await;
    let (panel, outcome) = ask(&h.harness, "main", "hello again").await;
    assert!(outcome.is_ok(), "{:?}", panel.events());
    assert_eq!(panel.said(), "You said: hello again");
    // The new process does not know the old conversation, and says so
    // rather than carrying on as if it did.
    assert!(panel.events().iter().any(|event| matches!(event,
        AgentEvent::Notice { text } if text.contains("fresh conversation"))));
}

#[tokio::test]
async fn cancel_stops_a_turn_early_but_still_finishes_it() {
    let h = harnessed("codex").await;
    let harness = Arc::new(h.harness);
    let panel = Panel::default();
    let running = {
        let harness = Arc::clone(&harness);
        let emit = panel.emit();
        tokio::spawn(async move { harness.prompt("main", None, "SLOW", None, emit).await })
    };
    timeout(Duration::from_secs(5), async {
        while panel.said().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the answer starts");
    harness.cancel("main").await.unwrap();

    let stop = running
        .await
        .unwrap()
        .expect("a cancelled turn still ends well");
    assert_eq!(stop, "cancelled");
    assert!(panel.said().contains("word"), "the words so far are kept");
    assert!(panel.said().matches("word").count() < 100);
    assert_eq!(panel.last(), Some(done("cancelled")));
}

#[tokio::test]
async fn one_window_asks_one_thing_at_a_time() {
    let h = harnessed("codex").await;
    let harness = Arc::new(h.harness);
    let first = {
        let harness = Arc::clone(&harness);
        tokio::spawn(async move {
            harness
                .prompt("main", None, "SLOW", None, Panel::default().emit())
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (_, second) = ask(&harness, "main", "and this").await;
    assert!(second.unwrap_err().message.contains("already waiting"));
    harness.cancel("main").await.unwrap();
    first.await.unwrap().unwrap();
}

#[tokio::test]
async fn two_windows_hold_two_conversations() {
    let h = harnessed("codex").await;
    let harness = Arc::new(h.harness);
    let ask_in = |window: &'static str, text: &'static str| {
        let harness = Arc::clone(&harness);
        tokio::spawn(async move { ask(&harness, window, text).await })
    };
    let (one, two) = tokio::join!(ask_in("main", "SLOW"), ask_in("second", "hello from two"));
    let (one, two) = (one.unwrap().0, two.unwrap().0);
    assert_eq!(one.said().matches("word").count(), 200);
    assert_eq!(two.said(), "You said: hello from two");

    let (one, _) = ask(&harness, "main", "SHOW_CWD").await;
    let (two, _) = ask(&harness, "second", "SHOW_CWD").await;
    assert_ne!(one.said(), two.said(), "each window has its own session");
}

#[tokio::test]
async fn the_session_cwd_is_a_fresh_empty_dir_outside_the_vault() {
    let h = harnessed("claude").await;
    let vault = tempfile::tempdir().unwrap();
    let panel = Panel::default();
    h.harness
        .prompt("main", Some(vault.path()), "SHOW_CWD", None, panel.emit())
        .await
        .unwrap();
    let said = panel.said();
    let rest = said
        .strip_prefix("cwd ")
        .expect("the mock says where it is");
    let (cwd, entries) = rest.rsplit_once(' ').unwrap();
    let cwd = Path::new(cwd);
    assert_eq!(entries, "0", "the session's folder starts empty");
    assert!(
        cwd.starts_with(&h.sessions),
        "{cwd:?} is not with the sessions"
    );
    assert!(!cwd.starts_with(vault.path().canonicalize().unwrap()));
    assert!(cwd.is_dir());

    // A new conversation gets a new folder, and the old one is cleared away.
    h.harness.new_chat("main").await;
    assert!(!cwd.exists());
    let (again, _) = ask(&h.harness, "main", "SHOW_CWD").await;
    assert!(!again.said().contains(cwd.to_str().unwrap()));
}

#[tokio::test]
async fn closing_a_window_cancels_its_turn_and_drops_its_session() {
    let h = harnessed("codex").await;
    let harness = Arc::new(h.harness);
    let (before, _) = ask(&harness, "main", "SHOW_CWD").await;

    let panel = Panel::default();
    let running = {
        let harness = Arc::clone(&harness);
        let emit = panel.emit();
        tokio::spawn(async move { harness.prompt("main", None, "SLOW", None, emit).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    harness.forget_window("main").await;
    assert_eq!(running.await.unwrap().unwrap(), "cancelled");

    let (after, _) = ask(&harness, "main", "SHOW_CWD").await;
    assert_ne!(before.said(), after.said());
}

#[tokio::test]
async fn deltas_are_coalesced_before_crossing_ipc() {
    let h = harnessed("codex").await;
    let harness = h
        .harness
        .with_coalescing(Duration::from_millis(200), 1 << 20);
    let (panel, _) = ask(&harness, "main", "SLOW").await;
    let tokens = panel
        .events()
        .iter()
        .filter(|event| matches!(event, AgentEvent::Token { .. }))
        .count();
    // 200 words over four seconds, sent on five times a second.
    assert_eq!(panel.said().matches("word").count(), 200);
    assert!(tokens < 40, "{tokens} sends for 200 words");
}

#[tokio::test]
async fn a_conversation_the_agent_does_not_have_is_given_everything() {
    use super::harness::Question;
    let h = harnessed("claude").await;
    let asked = || Question {
        text: "brief SHOW_PROMPT",
        in_full: Some("full SHOW_PROMPT"),
    };
    let turn = || async {
        let panel = Panel::default();
        h.harness
            .prompt("main", None, asked(), None, panel.emit())
            .await
            .unwrap();
        panel.said()
    };

    // The first question in a conversation goes in full; a follow-up in the
    // same conversation goes as it is.
    assert_eq!(turn().await, "full SHOW_PROMPT");
    assert_eq!(turn().await, "brief SHOW_PROMPT");

    // An agent that restarted has lost the conversation, and is given
    // everything again.
    let _ = ask(&h.harness, "main", "CRASH").await;
    assert_eq!(turn().await, "full SHOW_PROMPT");
}

#[tokio::test]
async fn moves_off_a_model_the_account_does_not_offer() {
    // The Codex mock starts every session on a model it does not offer.
    let h = harnessed("codex").await;
    let (panel, _) = ask(&h.harness, "main", "SHOW_MODEL").await;
    assert_eq!(panel.said(), "model current[low]");
}

#[tokio::test]
async fn switches_again_when_a_prompt_is_turned_down() {
    let h = harnessed("codex").await;
    let (panel, outcome) = ask(&h.harness, "main", "REJECT_MODEL SHOW_MODEL").await;
    assert!(outcome.is_ok(), "{:?}", panel.events());
    assert_eq!(panel.said(), "model backup[low]");
    assert!(panel.events().iter().any(|event| matches!(event,
        AgentEvent::Notice { text } if text.contains("backup[low]"))));

    // And it stays off the refused model in a new conversation.
    h.harness.new_chat("main").await;
    let (panel, _) = ask(&h.harness, "main", "SHOW_MODEL").await;
    assert_eq!(panel.said(), "model backup[low]");
}

#[tokio::test]
async fn reports_the_error_when_every_model_is_turned_down() {
    let h = harnessed("codex").await;
    let (panel, outcome) = ask(&h.harness, "main", "REJECT_ALL").await;
    assert_eq!(outcome.unwrap_err().kind, ErrorKind::ModelUnavailable);
    assert!(matches!(
        panel.last(),
        Some(AgentEvent::Failed {
            code: ErrorKind::ModelUnavailable,
            ..
        })
    ));
}

#[tokio::test]
async fn the_model_the_person_picks_is_the_one_that_answers() {
    for (flavor, model) in [("codex", "backup[low]"), ("claude", "haiku")] {
        let h = harnessed(flavor).await;
        let models = h.harness.list_models().await.unwrap();
        assert!(models.iter().any(|m| m.id == model), "{flavor}: {models:?}");

        let panel = Panel::default();
        h.harness
            .prompt("main", None, "SHOW_MODEL", Some(model), panel.emit())
            .await
            .unwrap();
        assert_eq!(panel.said(), format!("model {model}"), "{flavor}");
    }
}

#[tokio::test]
async fn nothing_is_started_while_ai_is_off() {
    let h = harnessed("codex").await;
    h.harness.set_agent(None).await;
    let (panel, outcome) = ask(&h.harness, "main", "hello").await;
    assert_eq!(outcome.unwrap_err().kind, ErrorKind::Off);
    assert!(panel.events().is_empty());
    assert!(!h.harness.running().await);
    assert_eq!(h.harness.warm().await.unwrap_err().kind, ErrorKind::Off);
}

#[tokio::test]
async fn a_usage_limit_is_the_agents_and_said_to_be() {
    let h = harnessed("claude").await;
    let (_, outcome) = ask(&h.harness, "main", "USAGE_LIMIT").await;
    let error = outcome.unwrap_err();
    assert_eq!(error.kind, ErrorKind::UsageLimit);
    assert_eq!(
        error.message,
        "You've hit Claude Code's usage limit. Try again once it resets."
    );
}

#[tokio::test]
async fn a_custom_agent_that_cannot_start_is_reported_at_once() {
    // The real launcher, so what the config says is what is run.
    let harness = AgentHarness::new(
        Arc::new(super::start::command_for),
        std::env::temp_dir().join("nuza-agent-test-sessions"),
    );
    let started = timeout(
        Duration::from_secs(20),
        harness.use_agent(AgentConfig::Custom {
            command: "definitely-not-a-real-program-xyz".into(),
            args: vec![],
            data_dirs: vec![],
        }),
    )
    .await
    .expect("fails, rather than waiting");
    let error = started.unwrap_err();
    assert_eq!(error.kind, ErrorKind::AgentMissing);
    assert!(
        error.message.contains("definitely-not-a-real-program-xyz"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn a_custom_agent_runs_a_conversation_end_to_end() {
    let _turn = one_at_a_time().await;
    // The mock, through the custom-agent path and - on macOS - the sandbox,
    // with its script in a folder the sandbox would otherwise keep it from.
    let harness = AgentHarness::new(
        Arc::new(super::start::command_for),
        std::env::temp_dir().join("nuza-agent-test-sessions"),
    );
    harness
        .use_agent(AgentConfig::Custom {
            command: "node".into(),
            args: vec![
                mock_script().to_string_lossy().into_owned(),
                "--flavor".into(),
                "claude".into(),
            ],
            data_dirs: vec![],
        })
        .await
        .expect("the custom agent starts");
    let (panel, outcome) = ask(&harness, "main", "hello custom").await;
    assert!(outcome.is_ok(), "{:?}", panel.events());
    assert_eq!(panel.said(), "You said: hello custom");
    harness.shutdown().await;
}

#[tokio::test]
async fn the_webview_cannot_choose_the_command() {
    // A preset carries nothing that says what to run; whatever else arrives
    // with it is ignored, and the command is the pinned one.
    let config: AgentConfig = serde_json::from_value(json!({
        "kind": "claudeCode",
        "command": "rm",
        "args": ["-rf", "~"],
    }))
    .unwrap();
    assert_eq!(config, AgentConfig::ClaudeCode);
    let launch = config.launch(Some(Path::new("/Users/me"))).unwrap();
    assert_eq!(launch.program, "npx");
    assert_eq!(
        launch.args.last().map(String::as_str),
        Some(super::config::CLAUDE_ADAPTER)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn no_agent_process_survives_shutdown() {
    let h = harnessed("codex").await;
    let (panel, _) = ask(&h.harness, "main", "SHOW_PID").await;
    let pid: libc::pid_t = panel
        .said()
        .trim()
        .strip_prefix("pid ")
        .unwrap()
        .parse()
        .unwrap();
    assert!(h.harness.running().await);

    h.harness.shutdown().await;

    let alive = |pid| unsafe { libc::kill(pid, 0) } == 0;
    timeout(Duration::from_secs(5), async {
        while alive(pid) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the agent has gone");
    assert!(!h.harness.running().await);
}

/// A real agent, through the whole harness: the preset's pinned command, the
/// login shell's PATH and, on macOS, the sandbox.
async fn real_agent(config: AgentConfig) -> AgentHarness {
    let harness = AgentHarness::new(
        Arc::new(super::start::command_for),
        super::start::sessions_root(),
    );
    let name = config.label();
    timeout(Duration::from_secs(300), harness.use_agent(config))
        .await
        .expect("starts in time")
        .unwrap_or_else(|error| panic!("{name} did not start: {error:?}"));
    harness
}

/// Opt-in: the real Claude Code, signed in, on its own plan.
#[tokio::test]
#[ignore]
async fn real_claude_streams_through_the_harness() {
    let harness = real_agent(AgentConfig::ClaudeCode).await;
    let panel = Panel::default();
    let outcome = harness
        .prompt(
            "main",
            None,
            "Reply with exactly: hello from nuza",
            None,
            panel.emit(),
        )
        .await;
    for event in panel.events() {
        println!("{event:?}");
    }
    println!("OUTCOME: {outcome:?}");
    assert!(outcome.is_ok());
    assert!(panel.said().to_lowercase().contains("hello"));
    println!("MODELS: {:?}", harness.list_models().await.map(|m| m.len()));
    harness.shutdown().await;
}

/// Opt-in: the real OpenCode, signed in, on its own plan.
#[tokio::test]
#[ignore]
async fn real_opencode_streams_through_the_harness() {
    let harness = real_agent(AgentConfig::OpenCode).await;
    let models = harness.list_models().await.unwrap();
    println!("MODELS: {}", models.len());
    let panel = Panel::default();
    let outcome = harness
        .prompt(
            "main",
            None,
            "Reply with exactly: hello from nuza",
            None,
            panel.emit(),
        )
        .await;
    for event in panel.events() {
        println!("{event:?}");
    }
    println!("OUTCOME: {outcome:?}");
    assert!(outcome.is_ok());
    harness.shutdown().await;
}

/// Opt-in: the real Codex, signed in, on its own plan.
#[tokio::test]
#[ignore]
async fn real_codex_streams_through_the_harness() {
    let harness = real_agent(AgentConfig::Codex).await;
    let panel = Panel::default();
    let outcome = harness
        .prompt(
            "main",
            None,
            "Reply with exactly: hello from nuza",
            None,
            panel.emit(),
        )
        .await;
    println!("OUTCOME: {outcome:?} SAID: {}", panel.said());
    assert!(outcome.is_ok());
    harness.shutdown().await;
}

/// Opt-in: Claude Code's first start, from an empty npm cache, through the
/// real fenced command - the adapter is downloaded inside the sandbox. Run
/// with HOME pointing at an empty folder to make the cache cold.
#[tokio::test]
#[ignore]
async fn real_claude_starts_from_a_cold_cache_inside_the_fence() {
    let command =
        tokio::task::spawn_blocking(|| super::start::command_for(&AgentConfig::ClaudeCode))
            .await
            .unwrap()
            .expect("a command for Claude Code");
    let (sender, _inbound) = mpsc::unbounded_channel();
    let client = RpcClient::spawn(command, sender, Arc::new(RefuseAll)).unwrap();
    let started = std::time::Instant::now();
    let hello = client
        .request(
            "initialize",
            json!({ "protocolVersion": 1, "clientCapabilities": {} }),
        )
        .await;
    println!(
        "COLD START: {:?} after {:?}",
        hello.as_ref().map(|_| "answered"),
        started.elapsed()
    );
    assert!(hello.is_ok(), "{hello:?}");
    client.kill().await;
}
