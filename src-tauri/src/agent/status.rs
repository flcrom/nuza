//! What is installed on this computer, for the setup checklist.
//!
//! Only local programs are run - `claude --version`, `codex login status` -
//! and nothing is contacted. None of this runs until the person opens the AI
//! settings or has already turned an agent on.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

/// How long a `--version` gets. A program that hangs on it is reported as
/// not answering rather than holding the checklist up.
const PATIENCE: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Detection {
    /// Node's version, present only when `npx` is there as well - the two
    /// adapters that need Node are run through it.
    pub(crate) node: Option<String>,
    pub(crate) agents: Vec<Found>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Found {
    /// "claude-code", "codex" or "opencode".
    pub(crate) id: &'static str,
    /// Where its program is, if it is anywhere.
    pub(crate) path: Option<String>,
    pub(crate) version: Option<String>,
    /// Only Codex says whether it is signed in in a way nuza can read.
    /// `None` is "nuza cannot tell", which must never be shown as signed out.
    pub(crate) signed_in: Option<bool>,
}

/// Looks for every agent nuza has a preset for. `path` is the `PATH` to look
/// along - the merged one from `shellpath`.
pub(crate) async fn detect(path: &OsStr) -> Detection {
    let program = |name: &str| resolve_command(name, path);
    let (node, npx) = (program("node"), program("npx"));
    let (claude, codex, opencode) = (program("claude"), program("codex"), program("opencode"));

    let (node_version, claude_version, codex_version, opencode_version, codex_login) = tokio::join!(
        version_of(node.as_deref(), path),
        version_of(claude.as_deref(), path),
        version_of(codex.as_deref(), path),
        version_of(opencode.as_deref(), path),
        codex_signed_in(codex.as_deref(), path),
    );

    // Found means it answered. A program of the right name that does not -
    // a wrapper script with nothing behind it, a broken install - is not an
    // agent anyone can use, and offering it would only fail at the first
    // question.
    let found = |id, at: Option<PathBuf>, version: Option<String>, signed_in: Option<bool>| {
        let answered = version.is_some();
        Found {
            id,
            path: at
                .filter(|_| answered)
                .map(|at| at.to_string_lossy().into_owned()),
            version,
            signed_in: signed_in.filter(|_| answered),
        }
    };
    Detection {
        node: node_version.filter(|_| npx.is_some()),
        agents: vec![
            found("claude-code", claude, claude_version, None),
            found("codex", codex, codex_version, codex_login),
            found("opencode", opencode, opencode_version, None),
        ],
    }
}

/// The first line `program --version` prints, if it answers in time.
async fn version_of(program: Option<&Path>, path: &OsStr) -> Option<String> {
    let mut command = Command::new(program?);
    command
        .arg("--version")
        .env("PATH", path)
        .kill_on_drop(true);
    let output = tokio::time::timeout(PATIENCE, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// Whether Codex is signed in, when there is a Codex to ask.
async fn codex_signed_in(codex: Option<&Path>, path: &OsStr) -> Option<bool> {
    let mut command = Command::new(codex?);
    command
        .args(["login", "status"])
        .env("PATH", path)
        .kill_on_drop(true);
    let output = tokio::time::timeout(PATIENCE, command.output())
        .await
        .ok()?
        .ok()?;
    Some(read_login_status(
        output.status.success(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    ))
}

/// What `codex login status` said. It writes "Logged in using ChatGPT" to
/// **stderr**, and exits 0 signed in or not, so both streams are read: the
/// obvious reading of stdout alone reports everyone as signed out.
fn read_login_status(success: bool, stdout: &str, stderr: &str) -> bool {
    let said = format!("{stdout}\n{stderr}").to_lowercase();
    success && !said.contains("not logged in") && !said.contains("logged out")
}

/// Starts `codex login`, which opens a browser of its own. Not waited on:
/// the checklist looks again a little later, and nuza never sees a token.
pub(crate) fn codex_login(path: &OsStr) -> Result<(), String> {
    let codex = resolve_command("codex", path).ok_or("Codex is not installed")?;
    std::process::Command::new(codex)
        .args(["login"])
        .env("PATH", path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not start `codex login`: {error}"))
}

/// Where `command` is, found the way a shell would: as it is when it has a
/// path in it (`~/` allowed), or else the first executable file of that name
/// along `path`. Not `which`, which is not on every system and does not take
/// a `PATH` of nuza's choosing.
pub(crate) fn resolve_command(command: &str, path: &OsStr) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    if command.contains('/') || command.contains('\\') {
        let at = super::config::expand_home(command, super::config::home_dir().as_deref());
        return candidates(&at).into_iter().find(|at| is_program(at));
    }
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .flat_map(|dir| candidates(&dir.join(command)))
        .find(|at| is_program(at))
}

fn is_program(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && is_executable(&metadata))
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

/// Windows has no execute bit: a program is what its extension says.
#[cfg(not(unix))]
fn is_executable(_: &std::fs::Metadata) -> bool {
    true
}

/// The files `path` may mean. On Windows a program is typed without its
/// extension (`npx` is `npx.cmd`), so `PATHEXT`'s are tried too.
fn candidates(path: &Path) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut all = vec![path.to_path_buf()];
        if path.extension().is_none() {
            let extensions =
                std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
            for extension in extensions.split(';').filter(|e| !e.is_empty()) {
                let mut name = path.as_os_str().to_os_string();
                name.push(extension);
                all.push(PathBuf::from(name));
            }
        }
        all
    }
    #[cfg(not(windows))]
    {
        vec![path.to_path_buf()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system_path() -> std::ffi::OsString {
        std::env::var_os("PATH").unwrap_or_default()
    }

    #[cfg(unix)]
    #[test]
    fn a_program_is_found_by_name_or_by_path() {
        let path = system_path();
        assert!(resolve_command("sh", &path).is_some());
        assert!(resolve_command("/bin/sh", &path).is_some());
        assert!(resolve_command("definitely-not-a-real-program-xyz", &path).is_none());
        assert!(resolve_command("   ", &path).is_none());
        // There, but not a program.
        assert!(resolve_command("/etc/hosts", &path).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn the_path_searched_is_the_one_given() {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("my-agent");
        std::fs::write(&program, "#!/bin/sh\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            resolve_command("my-agent", dir.path().as_os_str()),
            Some(program)
        );
        assert_eq!(resolve_command("my-agent", OsStr::new("/usr/bin")), None);
        // A relative entry in PATH is not somewhere to look.
        assert_eq!(resolve_command("my-agent", OsStr::new(".")), None);
    }

    #[cfg(windows)]
    #[test]
    fn a_program_is_found_without_its_extension() {
        assert!(resolve_command("cmd", &system_path()).is_some());
        assert!(resolve_command("definitely-not-a-real-program-xyz", &system_path()).is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_program_that_does_not_answer_is_not_an_agent() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        // What a wrapper with nothing behind it does.
        let wrapper = dir.path().join("codex");
        std::fs::write(&wrapper, "#!/bin/sh\necho 'codex not found' >&2\nexit 1\n").unwrap();
        let working = dir.path().join("opencode");
        std::fs::write(&working, "#!/bin/sh\necho 1.15.13\n").unwrap();
        for program in [&wrapper, &working] {
            std::fs::set_permissions(program, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let found = detect(dir.path().as_os_str()).await;
        let codex = found.agents.iter().find(|a| a.id == "codex").unwrap();
        assert_eq!((codex.path.as_deref(), codex.signed_in), (None, None));
        let opencode = found.agents.iter().find(|a| a.id == "opencode").unwrap();
        assert!(opencode.path.is_some());
        assert_eq!(opencode.version.as_deref(), Some("1.15.13"));
    }

    #[test]
    fn signed_in_is_said_on_stderr_and_still_counts() {
        assert!(read_login_status(true, "", "Logged in using ChatGPT\n"));
    }

    #[test]
    fn signed_out_is_read_from_either_stream_or_the_exit() {
        assert!(!read_login_status(true, "Not logged in", ""));
        assert!(!read_login_status(true, "", "You are logged out"));
        assert!(!read_login_status(false, "", ""));
    }

    #[tokio::test]
    async fn a_machine_with_nothing_installed_is_reported_as_such() {
        let empty = tempfile::tempdir().unwrap();
        let found = detect(empty.path().as_os_str()).await;
        assert_eq!(found.node, None);
        assert_eq!(found.agents.len(), 3);
        for agent in found.agents {
            assert_eq!(
                (agent.path, agent.version, agent.signed_in),
                (None, None, None)
            );
        }
    }
}
