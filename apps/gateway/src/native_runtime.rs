use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config::Config;

const MARKER: &str = "instance.json";
const LOCK: &str = ".instance.lock";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InstanceMarker {
    format: u32,
    id: Uuid,
}

/// The operating-system lock lives as long as the gateway, including its workers.
pub struct PreparedInstance {
    _lock: File,
}

pub fn prepare_instance(config: &mut Config) -> anyhow::Result<PreparedInstance> {
    reject_local_managed_configuration()?;
    let mut protected_homes = vec![config.projects.home_dir.join(".codex")];
    if let Some(home) = std::env::var_os("CODEX_HOME") {
        let home = PathBuf::from(home);
        if canonical_future_path(&home)? != canonical_future_path(&config.codex.home)? {
            protected_homes.push(home);
        }
    }
    prepare_at(config, &protected_homes)
}

fn prepare_at(
    config: &mut Config,
    protected_homes: &[PathBuf],
) -> anyhow::Result<PreparedInstance> {
    let root = canonical_future_path(&config.instance.data_dir)?;
    for home in protected_homes {
        let home = canonical_future_path(home)?;
        if root.starts_with(&home) || home.starts_with(&root) {
            bail!(
                "Kodex instance root overlaps a protected Codex home: {}",
                root.display()
            );
        }
    }
    let database = canonical_future_path(&config.database.path)?;
    let native_home = canonical_future_path(&config.codex.home)?;
    if database != root.join("gateway.db") || native_home != root.join("codex-home") {
        bail!("Kodex database and native home must be owned paths inside the fresh instance root");
    }
    for path in [
        root.join(MARKER),
        root.join(LOCK),
        database.clone(),
        native_home.clone(),
    ] {
        reject_leaf_symlink(&path)?;
    }
    // Fixed storage roots used by the pinned native runtime. Check their parents
    // too, without traversing plugin contents or ambient skill discovery roots.
    for relative_path in [
        "auth.json",
        ".credentials.json",
        "config.toml",
        "sqlite",
        "log",
        "sessions",
        "plugins/cache",
        "plugins/data",
        "plugins/data/agent-plugins",
        "plugins/.remote-plugin-install-staging",
        "plugins/.marketplace-plugin-source-staging",
        "cache/remote_plugin_catalog",
        ".tmp/plugins",
        ".tmp/marketplaces",
        ".tmp/bundled-marketplaces",
        "skills/.system",
    ] {
        let mut path = native_home.clone();
        for component in Path::new(relative_path).components() {
            path.push(component.as_os_str());
            reject_leaf_symlink(&path)?;
        }
    }
    reject_unrecognized_root(&root)?;
    fs::create_dir_all(&root).context("creating Kodex instance root")?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(LOCK))?;
    lock.try_lock()
        .context("another gateway already owns this Kodex instance")?;
    // Recheck after locking: another initializer may have completed before us.
    reject_unrecognized_root(&root)?;
    let marker_path = root.join(MARKER);
    let marker = if marker_path.exists() {
        read_marker(&marker_path)?
    } else {
        let marker = InstanceMarker {
            format: 1,
            id: Uuid::new_v4(),
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker_path)?;
        file.write_all(&serde_json::to_vec(&marker)?)?;
        file.sync_all()?;
        marker
    };
    fs::create_dir_all(&native_home)?;
    config.instance.data_dir = root;
    config.instance.id = marker.id.to_string();
    config.database.path = database;
    config.codex.home = native_home;
    Ok(PreparedInstance { _lock: lock })
}

fn read_marker(path: &Path) -> anyhow::Result<InstanceMarker> {
    let marker: InstanceMarker = serde_json::from_slice(&fs::read(path)?)
        .context("invalid Kodex instance marker; legacy state is not imported")?;
    if marker.format != 1 || marker.id.is_nil() {
        bail!("unsupported Kodex instance marker; legacy state is not imported");
    }
    Ok(marker)
}

fn reject_unrecognized_root(root: &Path) -> anyhow::Result<()> {
    if root.join(MARKER).exists() {
        read_marker(&root.join(MARKER))?;
    } else if root.try_exists()? {
        for entry in fs::read_dir(root)? {
            if entry?.file_name() != LOCK {
                bail!("refusing nonempty unrecognized Kodex state at {}; choose a fresh KODEX_DATA_DIR", root.display());
            }
        }
    }
    Ok(())
}

pub(crate) fn reject_leaf_symlink(path: &Path) -> anyhow::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("Kodex-owned state cannot be a symlink: {}", path.display())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn canonical_future_path(path: &Path) -> anyhow::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    let mut ancestor = normalized.as_path();
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    ancestor
                        .file_name()
                        .context("state path has no existing ancestor")?,
                );
                ancestor = ancestor.parent().context("state path has no parent")?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    let mut resolved = fs::canonicalize(ancestor)?;
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn reject_local_managed_configuration() -> anyhow::Result<()> {
    for path in [
        "/etc/codex/managed_config.toml",
        "/etc/codex/requirements.toml",
    ] {
        if Path::new(path).try_exists()? {
            bail!("managed Codex configuration is unsupported by this isolated Kodex runtime ({path}); native managed settings can override its storage paths");
        }
    }
    #[cfg(target_os = "macos")]
    if has_forced_macos_configuration()? {
        bail!("managed macOS Codex configuration is unsupported by this isolated Kodex runtime; native managed settings can override its storage paths");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn has_forced_macos_configuration() -> anyhow::Result<bool> {
    use std::ffi::{c_char, c_void, CString};
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            value: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFPreferencesAppValueIsForced(key: *const c_void, application: *const c_void) -> u8;
        fn CFRelease(value: *const c_void);
    }
    // Query only the forced-value flags; no desktop preferences or secrets are read.
    unsafe {
        let domain = CString::new("com.openai.codex")?;
        let application = CFStringCreateWithCString(std::ptr::null(), domain.as_ptr(), 0x08000100);
        if application.is_null() {
            bail!("cannot check managed Codex preferences");
        }
        let mut forced = false;
        for name in ["config_toml_base64", "requirements_toml_base64"] {
            let name = CString::new(name)?;
            let key = CFStringCreateWithCString(std::ptr::null(), name.as_ptr(), 0x08000100);
            if key.is_null() {
                CFRelease(application);
                bail!("cannot check managed Codex preferences");
            }
            forced |= CFPreferencesAppValueIsForced(key, application) != 0;
            CFRelease(key);
        }
        CFRelease(application);
        Ok(forced)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fixture(root: &Path) -> Config {
        let mut config = Config::default();
        config.instance.data_dir = root.to_path_buf();
        config.database.path = root.join("gateway.db");
        config.codex.home = root.join("codex-home");
        config
    }

    #[test]
    fn fresh_instance_reopens_with_the_same_identity_and_exclusive_owner() {
        let dir = tempdir().unwrap();
        let mut config = fixture(&dir.path().join("fresh"));
        let guard = prepare_at(&mut config, &[]).unwrap();
        let id = config.instance.id.clone();
        assert!(config.codex.home.is_dir());
        assert!(prepare_at(&mut config.clone(), &[]).is_err());
        drop(guard);
        let mut reopened = fixture(&dir.path().join("fresh"));
        let _guard = prepare_at(&mut reopened, &[]).unwrap();
        assert_eq!(reopened.instance.id, id);
    }

    #[test]
    fn legacy_state_is_rejected_without_modification() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("gateway.db");
        fs::write(&database, b"legacy database sentinel").unwrap();
        let mut config = fixture(dir.path());
        assert!(prepare_at(&mut config, &[]).is_err());
        assert_eq!(fs::read(database).unwrap(), b"legacy database sentinel");
        assert!(!dir.path().join(MARKER).exists());
        assert!(!dir.path().join("codex-home").exists());
    }

    #[test]
    fn an_external_database_override_is_rejected_before_initialization() {
        let dir = tempdir().unwrap();
        let old = dir.path().join("old.db");
        fs::write(&old, b"old database").unwrap();
        let mut config = fixture(&dir.path().join("fresh"));
        config.database.path = old.clone();
        assert!(prepare_at(&mut config, &[]).is_err());
        assert_eq!(fs::read(old).unwrap(), b"old database");
        assert!(!config.instance.data_dir.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_home_alias_cannot_adopt_desktop_state() {
        let dir = tempdir().unwrap();
        let desktop = dir.path().join("desktop");
        fs::create_dir(&desktop).unwrap();
        fs::write(desktop.join("auth.json"), b"desktop sentinel").unwrap();
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&desktop, &alias).unwrap();
        let mut config = fixture(&alias);
        assert!(prepare_at(&mut config, std::slice::from_ref(&desktop)).is_err());
        assert_eq!(
            fs::read(desktop.join("auth.json")).unwrap(),
            b"desktop sentinel"
        );
        assert!(!desktop.join(MARKER).exists());
    }

    #[test]
    fn malformed_marker_cannot_authorize_legacy_state() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(MARKER), b"{}").unwrap();
        let mut config = fixture(dir.path());
        assert!(prepare_at(&mut config, &[]).is_err());
        assert!(!dir.path().join("codex-home").exists());
        assert!(!dir.path().join(LOCK).exists());
    }
    #[cfg(unix)]
    #[test]
    fn a_recognized_instance_cannot_redirect_native_credentials() {
        let dir = tempdir().unwrap();
        let mut config = fixture(&dir.path().join("fresh"));
        let guard = prepare_at(&mut config, &[]).unwrap();
        drop(guard);
        let old_auth = dir.path().join("desktop-auth.json");
        fs::write(&old_auth, b"desktop auth sentinel").unwrap();
        std::os::unix::fs::symlink(&old_auth, config.codex.home.join("auth.json")).unwrap();
        assert!(prepare_at(&mut config, &[]).is_err());
        assert_eq!(fs::read(old_auth).unwrap(), b"desktop auth sentinel");
    }

    #[cfg(unix)]
    #[test]
    fn a_recognized_instance_cannot_redirect_native_plugins() {
        assert_managed_root_alias_is_rejected("plugins");
    }

    #[cfg(unix)]
    #[test]
    fn a_recognized_instance_cannot_redirect_native_plugin_cache() {
        assert_managed_root_alias_is_rejected("plugins/cache");
    }

    #[cfg(unix)]
    #[test]
    fn native_managed_data_staging_and_skill_roots_cannot_redirect_state() {
        for relative_path in [
            "plugins/data",
            "plugins/data/agent-plugins",
            "plugins/.remote-plugin-install-staging",
            "plugins/.marketplace-plugin-source-staging",
            "cache",
            "cache/remote_plugin_catalog",
            ".tmp",
            ".tmp/plugins",
            ".tmp/marketplaces",
            ".tmp/bundled-marketplaces",
            "skills",
            "skills/.system",
        ] {
            assert_managed_root_alias_is_rejected(relative_path);
        }
    }

    #[cfg(unix)]
    #[test]
    fn plugin_contents_and_custom_skill_links_remain_usable() {
        let dir = tempdir().unwrap();
        let mut config = fixture(&dir.path().join("fresh"));
        let guard = prepare_at(&mut config, &[]).unwrap();
        drop(guard);
        let shared_source = dir.path().join("shared-source");
        fs::create_dir(&shared_source).unwrap();
        fs::write(shared_source.join("sentinel"), b"shared source").unwrap();
        let plugin_root = config.codex.home.join("plugins/cache/fixture/plugin/1.0.0");
        fs::create_dir_all(&plugin_root).unwrap();
        let plugin_link = plugin_root.join("linked-content");
        std::os::unix::fs::symlink(&shared_source, &plugin_link).unwrap();
        let skills_root = config.codex.home.join("skills");
        fs::create_dir(&skills_root).unwrap();
        let skill_link = skills_root.join("custom-skill");
        std::os::unix::fs::symlink(&shared_source, &skill_link).unwrap();

        let _guard = prepare_at(&mut config, &[]).unwrap();
        assert_eq!(
            fs::read(plugin_link.join("sentinel")).unwrap(),
            b"shared source"
        );
        assert_eq!(
            fs::read(skill_link.join("sentinel")).unwrap(),
            b"shared source"
        );
        assert_eq!(fs::read_dir(&shared_source).unwrap().count(), 1);
    }

    #[cfg(unix)]
    fn assert_managed_root_alias_is_rejected(relative_path: &str) {
        let dir = tempdir().unwrap();
        let mut config = fixture(&dir.path().join("fresh"));
        let guard = prepare_at(&mut config, &[]).unwrap();
        drop(guard);
        let marker = fs::read(config.instance.data_dir.join(MARKER)).unwrap();
        let desktop_store = dir.path().join("desktop-store");
        fs::create_dir(&desktop_store).unwrap();
        fs::write(desktop_store.join("sentinel"), b"desktop state").unwrap();
        let alias = config.codex.home.join(relative_path);
        fs::create_dir_all(alias.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&desktop_store, &alias).unwrap();

        assert!(
            prepare_at(&mut config, &[]).is_err(),
            "native managed root must not redirect state: {relative_path}"
        );
        assert_eq!(
            fs::read(desktop_store.join("sentinel")).unwrap(),
            b"desktop state"
        );
        assert_eq!(fs::read_dir(&desktop_store).unwrap().count(), 1);
        assert_eq!(
            fs::read(config.instance.data_dir.join(MARKER)).unwrap(),
            marker
        );
        assert_eq!(fs::read_link(alias).unwrap(), desktop_store);
    }
}
