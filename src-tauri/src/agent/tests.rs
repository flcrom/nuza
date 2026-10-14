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

use super::rpc::{Inbound, RpcClient};

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
    let client = RpcClient::spawn(command, sender).expect("node runs the mock agent");
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
