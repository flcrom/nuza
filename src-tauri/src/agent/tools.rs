//! nuza's vault tools, as the harness hands them to a session: the
//! read-only server in `vaultserver.rs`, started the first time a session
//! wants it - a nuza that never opens the AI panel never opens a port.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use tauri::{AppHandle, Manager};

use super::harness::{ToolAccess, VaultTools};
use super::store::Store;
use crate::state::{locked, Windows};
use crate::vaultserver::VaultServer;

pub(crate) struct AppVaultTools {
    app: AppHandle,
    /// Started once, when first wanted; `None` inside if it could not be.
    server: OnceLock<Option<Arc<VaultServer>>>,
}

impl AppVaultTools {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self {
            app,
            server: OnceLock::new(),
        }
    }

    /// The server, if it has been started.
    pub(crate) fn running(&self) -> Option<Arc<VaultServer>> {
        self.server.get().cloned().flatten()
    }
}

impl VaultTools for AppVaultTools {
    fn open(&self, window: &str, vault: &Path) -> Option<ToolAccess> {
        if !self.app.state::<Store>().vault_search(vault) {
            return None;
        }
        // The window's own vault, and still the one asked about.
        let open = self.app.state::<Windows>().vault(window);
        if locked(&open.root).as_deref() != Some(vault) {
            return None;
        }
        let server = self
            .server
            .get_or_init(|| match VaultServer::start() {
                Ok(server) => Some(Arc::new(server)),
                Err(error) => {
                    log::error!("the vault tools could not start: {error}");
                    None
                }
            })
            .clone()?;
        let token = server.grant(open)?;
        Some(ToolAccess {
            url: server.url().to_string(),
            token,
        })
    }

    fn close(&self, token: &str) {
        if let Some(server) = self.running() {
            server.revoke(token);
        }
    }
}
