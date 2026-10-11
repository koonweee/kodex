use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const FORMAT: u32 = 1;
const MARKER: &str = "instance.json";
const LOCK: &str = ".instance.lock";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InstanceIdentity {
    pub format: u32,
    pub id: Uuid,
}

pub struct PreparedInstance {
    pub identity: InstanceIdentity,
    pub data_dir: PathBuf,
    _lock: File,
}

pub fn prepare(data_dir: &Path, database_path: &Path) -> anyhow::Result<PreparedInstance> {
    reject_symlink(data_dir)?;
    let data_dir = canonical_future_path(data_dir)?;
    let database_path = canonical_future_path(database_path)?;
    if database_path != data_dir.join("federator.db") {
        bail!("federator database must be <KODEX_FEDERATOR_DATA_DIR>/federator.db");
    }
    reject_symlink(&data_dir)?;
    reject_unrecognized_root(&data_dir)?;
    fs::create_dir_all(&data_dir).context("creating federator instance root")?;
    for path in [data_dir.join(MARKER), data_dir.join(LOCK), database_path] {
        reject_symlink(&path)?;
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data_dir.join(LOCK))?;
    lock.try_lock()
        .context("another federator already owns this instance")?;
    reject_unrecognized_root(&data_dir)?;
    let marker_path = data_dir.join(MARKER);
    let identity = if marker_path.exists() {
        let value: InstanceIdentity = serde_json::from_slice(&fs::read(&marker_path)?)
            .context("invalid federator instance marker")?;
        if value.format != FORMAT || value.id.is_nil() {
            bail!("unsupported federator instance marker");
        }
        value
    } else {
        let value = InstanceIdentity {
            format: FORMAT,
            id: Uuid::new_v4(),
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker_path)?;
        file.write_all(&serde_json::to_vec(&value)?)?;
        file.sync_all()?;
        value
    };
    Ok(PreparedInstance {
        identity,
        data_dir,
        _lock: lock,
    })
}

fn reject_unrecognized_root(root: &Path) -> anyhow::Result<()> {
    if root.join(MARKER).exists() {
        return Ok(());
    }
    if root.try_exists()? {
        for entry in fs::read_dir(root)? {
            if entry?.file_name() != LOCK {
                bail!(
                    "refusing nonempty unrecognized federator state at {}",
                    root.display()
                );
            }
        }
    }
    Ok(())
}

fn canonical_future_path(path: &Path) -> anyhow::Result<PathBuf> {
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

fn reject_symlink(path: &Path) -> anyhow::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!(
                "federator-owned state cannot be a symlink: {}",
                path.display()
            )
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_stable_and_exclusively_locked() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("federator.db");
        let first = prepare(dir.path(), &database).unwrap();
        assert!(prepare(dir.path(), &database).is_err());
        let id = first.identity.id;
        drop(first);
        assert_eq!(prepare(dir.path(), &database).unwrap().identity.id, id);
    }

    #[test]
    fn refuses_unrecognized_or_symlinked_state_roots() {
        let parent = tempfile::tempdir().unwrap();
        let occupied = parent.path().join("occupied");
        std::fs::create_dir(&occupied).unwrap();
        std::fs::write(occupied.join("foreign"), "data").unwrap();
        assert!(prepare(&occupied, &occupied.join("federator.db")).is_err());

        #[cfg(unix)]
        {
            let target = parent.path().join("target");
            std::fs::create_dir(&target).unwrap();
            let alias = parent.path().join("alias");
            std::os::unix::fs::symlink(&target, &alias).unwrap();
            assert!(prepare(&alias, &alias.join("federator.db")).is_err());
        }
    }
}
