//! The `PATH` a terminal would have, for starting an agent with.
//!
//! An app opened from the Finder, Spotlight or a desktop launcher does not
//! inherit the login shell's `PATH`. `claude`, `codex`, `opencode` and `npx`
//! are then nowhere to be found for exactly the people who have them, and the
//! AI panel looks broken on a machine that is set up correctly.
//!
//! So the login shell is asked for its `PATH`, once, and anything it has that
//! the app does not is added on the end. Asked the first time an agent is
//! needed rather than at launch: a nuza that never uses an agent never runs
//! the user's shell startup files, and a slow one never delays the window.
//! The answer is given to the agent's command, not set on this process, so
//! nothing else in the app sees its environment change underneath it.

use std::ffi::OsString;
use std::sync::OnceLock;
#[cfg(unix)]
use std::time::Duration;

/// Around the `PATH` in the shell's output, which may also hold whatever its
/// startup files print - a version manager's banner, a message of the day.
#[cfg_attr(not(unix), allow(dead_code))]
const MARKER: &str = "__NUZA_PATH__";

/// How long a login shell gets to answer. One that takes longer is carrying
/// on without, rather than holding up the first question to an agent.
#[cfg(unix)]
const PATIENCE: Duration = Duration::from_secs(3);

static MERGED: OnceLock<OsString> = OnceLock::new();

/// The `PATH` to start an agent with: the app's own, with what the login
/// shell adds after it. Blocks for up to three seconds the first time it is
/// called; call it off the async runtime's threads.
pub(crate) fn path() -> OsString {
    MERGED
        .get_or_init(|| {
            let own = std::env::var_os("PATH").unwrap_or_default();
            match login_shell_path() {
                Some(shell) => merge(&own, &shell),
                None => own,
            }
        })
        .clone()
}

#[cfg(unix)]
fn login_shell_path() -> Option<OsString> {
    use std::process::{Command, Stdio};

    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
    let (sender, answer) = std::sync::mpsc::channel();

    // On a thread of its own, so a shell that never finishes is only waited
    // on for as long as it deserves.
    std::thread::spawn(move || {
        let mut command = Command::new(shell);
        command
            .arg("-ilc")
            .arg(format!("printf '{MARKER}%s{MARKER}' \"$PATH\""))
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        crate::agent::start::leave_appimage_std(&mut command);
        let output = command.output();
        let _ = sender.send(output);
    });

    match answer.recv_timeout(PATIENCE) {
        Ok(Ok(output)) => {
            let printed = String::from_utf8_lossy(&output.stdout);
            between_markers(&printed).map(OsString::from)
        }
        _ => {
            log::warn!("the login shell did not say what its PATH is; using the app's own");
            None
        }
    }
}

/// Windows programs get the user's `PATH` however they are started.
#[cfg(not(unix))]
fn login_shell_path() -> Option<OsString> {
    None
}

/// The text printed between the two markers, if there is any.
#[cfg_attr(not(unix), allow(dead_code))]
fn between_markers(output: &str) -> Option<&str> {
    let start = output.find(MARKER)? + MARKER.len();
    let end = start + output[start..].find(MARKER)?;
    let path = output[start..end].trim();
    (!path.is_empty()).then_some(path)
}

/// `own`, with every entry of `shell` it lacks added after it, in order.
fn merge(own: &OsString, shell: &OsString) -> OsString {
    let mut entries: Vec<_> = std::env::split_paths(own)
        .filter(|entry| !entry.as_os_str().is_empty())
        .collect();
    for entry in std::env::split_paths(shell) {
        if !entry.as_os_str().is_empty() && !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    std::env::join_paths(entries).unwrap_or_else(|_| own.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_path_is_found_among_what_the_shell_printed() {
        let printed = "nvm: using node 24\n__NUZA_PATH__/a:/b__NUZA_PATH__\nwelcome back";
        assert_eq!(between_markers(printed), Some("/a:/b"));
    }

    #[test]
    fn output_without_a_path_is_no_path() {
        assert_eq!(between_markers("just a banner"), None);
        assert_eq!(between_markers("__NUZA_PATH____NUZA_PATH__"), None);
        assert_eq!(between_markers("__NUZA_PATH__/a only one marker"), None);
    }

    #[cfg(unix)]
    #[test]
    fn the_shell_only_adds_and_never_reorders() {
        let merged = merge(
            &"/usr/bin:/bin".into(),
            &"/opt/node/bin:/bin:/usr/bin".into(),
        );
        assert_eq!(merged, OsString::from("/usr/bin:/bin:/opt/node/bin"));
    }

    #[cfg(unix)]
    #[test]
    fn empty_entries_are_dropped_on_the_way() {
        let merged = merge(&"/usr/bin::".into(), &":/opt/x".into());
        assert_eq!(merged, OsString::from("/usr/bin:/opt/x"));
    }
}
