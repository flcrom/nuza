//! The agent nuza hands a question to: a program already on the user's
//! computer - Claude Code, Codex, OpenCode, anything that speaks ACP - started
//! by nuza and spoken to over its stdin and stdout. nuza runs no model, holds
//! no key and has no server; the agent does its own network calls, on the
//! user's own plan.

// Only the tests drive the client until the harness lands on top of it.
#![cfg_attr(not(test), allow(dead_code))]

pub(crate) mod rpc;

#[cfg(test)]
mod tests;
