//! The agent nuza hands a question to: a program already on the user's
//! computer - Claude Code, Codex, OpenCode, anything that speaks ACP - started
//! by nuza and spoken to over its stdin and stdout. nuza runs no model, holds
//! no key and has no server; the agent does its own network calls, on the
//! user's own plan.
//!
//! Nothing here runs until the person turns an agent on in Settings and
//! agrees to a notice saying what it will be sent.

pub(crate) mod commands;
mod config;
mod errors;
mod events;
mod harness;
mod rpc;
// Plain data, tested on every Unix; only macOS applies it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod sandbox;
pub(crate) mod start;
mod status;
pub(crate) mod store;

#[cfg(test)]
mod tests;

pub(crate) use harness::AgentHarness;
