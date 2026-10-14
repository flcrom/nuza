//! Turning an agent's config into the command that starts it, fenced in
//! where this computer can fence it in.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use tokio::process::Command;

use super::config::{home_dir, AgentConfig, Launch};
use super::status::resolve_command;

/// The one folder an agent may write freely, outside every vault and every
/// session directory: its `TMPDIR`, and its working directory.
const SCRATCH: &str = "nuza-agent-scratch";
/// Where each session's empty working directory is made.
const SESSIONS: &str = "nuza-agent-sessions";

/// Whether this computer runs the agent inside an operating-system sandbox.
/// Where it does not, the agent has the person's own permissions, and the
/// consent dialog says so in as many words.
pub(crate) fn sandboxed() -> bool {
    #[cfg(target_os = "macos")]
    {
        Path::new(SANDBOX_EXEC).exists()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(target_os = "macos")]
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// The temporary folder, as the sandbox sees it: resolved on macOS, where it
/// is behind a link and Seatbelt matches real paths. Left as it is elsewhere -
/// resolving it on Windows gives a `\\?\` path agents are not expecting.
fn temp_root() -> PathBuf {
    let temp = std::env::temp_dir();
    if cfg!(target_os = "macos") {
        temp.canonicalize().unwrap_or(temp)
    } else {
        temp
    }
}

/// Where the sessions' working directories go.
pub(crate) fn sessions_root() -> PathBuf {
    temp_root().join(SESSIONS)
}

/// The command that starts `config`'s agent.
pub(crate) fn command_for(config: &AgentConfig) -> Result<Command, String> {
    let path = crate::shellpath::path();
    let home = home_dir();
    let launch = config.launch(home.as_deref())?;
    let name = config.label();

    let program = resolve_command(&launch.program, &path).ok_or_else(|| {
        if config.needs_node() {
            format!("could not start {name}: npx was not found")
        } else {
            format!("could not start {name}: `{}` was not found", launch.program)
        }
    })?;
    if let Some(cache) = config.npm_cache(home.as_deref()) {
        repair_npm_cache(&cache);
    }
    let scratch = temp_root().join(SCRATCH);
    std::fs::create_dir_all(&scratch)
        .map_err(|error| format!("could not start {name}: no scratch folder: {error}"))?;

    let mut command = fenced(&program, &launch, home.as_deref(), &path, &scratch);
    command
        .env("PATH", &path)
        .env("TMPDIR", &scratch)
        // Never the app's own working directory, and somewhere the agent can
        // read: Node gives up outright in a working directory it cannot.
        .current_dir(&scratch);
    Ok(command)
}

/// Clears away any adapter download in nuza's own npm cache that was stopped
/// part way - by the app quitting, or the agent being turned off, while `npx`
/// was still fetching it.
///
/// `npx` keeps each package it runs in `_npx/<hash>`, and takes a folder that
/// is there as one that is ready: a half-written one, with no `package.json`
/// yet, fails every start after it with "ENOENT" until it is removed by hand.
/// The cache is nuza's alone, so nothing else can be using what is removed.
pub(crate) fn repair_npm_cache(cache: &Path) {
    let Ok(entries) = std::fs::read_dir(cache.join("_npx")) else {
        return;
    };
    for entry in entries.flatten() {
        let folder = entry.path();
        if folder.is_dir() && !folder.join("package.json").is_file() {
            log::warn!(
                "removing an adapter download that never finished: {}",
                folder.display()
            );
            let _ = std::fs::remove_dir_all(&folder);
        }
    }
}

#[cfg(target_os = "macos")]
fn fenced(
    program: &Path,
    launch: &Launch,
    home: Option<&Path>,
    path: &OsStr,
    scratch: &Path,
) -> Command {
    use super::sandbox::{node_roots, profile, program_dirs, Fence};

    if !sandboxed() {
        log::warn!("there is no sandbox-exec on this Mac; the agent runs without a fence");
        return unfenced(program, launch);
    }
    let real = |paths: &[PathBuf]| -> Vec<PathBuf> {
        let mut all = Vec::new();
        for path in paths {
            all.push(path.clone());
            if let Ok(resolved) = path.canonicalize() {
                if &resolved != path {
                    all.push(resolved);
                }
            }
        }
        all
    };
    let mut read_dirs = launch.read_dirs.clone();
    if let Some(home) = home {
        read_dirs.extend(node_roots(home, path));
        let name = program
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        read_dirs.extend(program_dirs(home, &name, path));
        for dir in [
            program.parent(),
            program
                .canonicalize()
                .ok()
                .as_deref()
                .and_then(Path::parent),
        ]
        .into_iter()
        .flatten()
        {
            if dir.starts_with(home) && dir != home {
                read_dirs.push(dir.to_path_buf());
            }
        }
    }
    let fence = Fence {
        home: home.map(|home| home.canonicalize().unwrap_or_else(|_| home.to_path_buf())),
        state_dirs: real(&launch.state_dirs),
        state_files: real(&launch.state_files),
        read_dirs: real(&read_dirs),
        scratch: Some(scratch.to_path_buf()),
    };
    let mut command = Command::new(SANDBOX_EXEC);
    command
        .arg("-p")
        .arg(profile(&fence))
        .arg("--")
        .arg(program)
        .args(&launch.args);
    command
}

#[cfg(not(target_os = "macos"))]
fn fenced(program: &Path, launch: &Launch, _: Option<&Path>, _: &OsStr, _: &Path) -> Command {
    log::warn!("no sandbox for the agent on this system; it runs with the user's permissions");
    unfenced(program, launch)
}

fn unfenced(program: &Path, launch: &Launch) -> Command {
    let mut command = Command::new(program);
    command.args(&launch.args);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_download_stopped_part_way_is_cleared_and_a_finished_one_kept() {
        let cache = tempfile::tempdir().unwrap();
        let npx = cache.path().join("_npx");
        let finished = npx.join("aaaa");
        let half = npx.join("bbbb");
        std::fs::create_dir_all(finished.join("node_modules")).unwrap();
        std::fs::write(finished.join("package.json"), "{}").unwrap();
        std::fs::create_dir_all(half.join("node_modules/@scope/pkg")).unwrap();

        repair_npm_cache(cache.path());

        assert!(finished.join("package.json").is_file());
        assert!(!half.exists());
        // A cache with nothing in it yet is fine too.
        repair_npm_cache(&cache.path().join("nowhere"));
    }
}
