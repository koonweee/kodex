//! Application-owned MCP registration and bundled skills.
use std::{
    collections::BTreeSet,
    fs, io,
    path::{Component, Path},
};

// Embedded assets always match the gateway release, including development and rollback.
const SKILL_FILES: &[(&str, &str)] = &[
    (
        "kodex-generative-ui/SKILL.md",
        include_str!("../../../../runtime/kodex/skills/kodex-generative-ui/SKILL.md"),
    ),
    (
        "kodex-generative-ui/agents/openai.yaml",
        include_str!("../../../../runtime/kodex/skills/kodex-generative-ui/agents/openai.yaml"),
    ),
];

pub(super) fn prepare(
    command: &mut tokio::process::Command,
    home: &Path,
    binary: &Path,
) -> io::Result<()> {
    reject_control_overrides(command)?;
    // Native table overrides merge, so a manual server cannot safely share this name.
    match fs::read_to_string(home.join("config.toml")) {
        Ok(contents) => {
            let config: toml::Value = toml::from_str(&contents).map_err(io::Error::other)?;
            if config
                .get("mcp_servers")
                .and_then(|servers| servers.get("kodex-control"))
                .is_some()
            {
                return Err(invalid("mcp_servers.kodex-control is reserved for built-in Kodex Control; remove or rename the manual entry in the dedicated CODEX_HOME/config.toml"));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    install_skills(home, SKILL_FILES)?;
    // Launch-only overrides do not register a plugin or edit the user's config.
    command.args([
        "-c", "plugins.kodex-control@kodex-local.enabled=false",
        "-c", &format!(
            "mcp_servers.kodex-control={{command={},args=[\"mcp\",\"kodex-control\"],enabled=true,env_vars=[\"KODEX_GATEWAY_URL\",\"KODEX_GATEWAY_BINARY\",\"KODEX_ALLOW_REMOTE_SELF_CONTROL\"]}}",
            serde_json::to_string(&binary.to_string_lossy())?
        ),
    ]);
    Ok(())
}

fn reject_control_overrides(command: &tokio::process::Command) -> io::Result<()> {
    let mut args = command.as_std().get_args();
    while let Some(arg) = args.next() {
        let arg = arg.to_string_lossy();
        let override_value = if arg == "-c" || arg == "--config" {
            args.next().map(|v| v.to_string_lossy().into_owned())
        } else {
            arg.strip_prefix("--config=")
                .or_else(|| arg.strip_prefix("-c").map(|v| v.trim_start_matches('=')))
                .map(str::to_owned)
        };
        let Some(value) = override_value else {
            continue;
        };
        let Some((key, value)) = value.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let reserved =
            key == "mcp_servers.kodex-control" || key.starts_with("mcp_servers.kodex-control.");
        let whole_table = if key == "mcp_servers" {
            let parsed: toml::Value =
                toml::from_str(&format!("servers={value}")).map_err(io::Error::other)?;
            parsed
                .get("servers")
                .and_then(|v| v.get("kodex-control"))
                .is_some()
        } else {
            false
        };
        if reserved || whole_table {
            return Err(invalid("mcp_servers.kodex-control is reserved for built-in Kodex Control; remove its override from KODEX_CODEX_ARGS"));
        }
    }
    Ok(())
}

const RECEIPT: &str = ".kodex-owned-files.json";

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn regular_directory(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_dir() => Ok(()),
        Ok(_) => Err(invalid(
            "Kodex skill directory must not be a symlink or file",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => fs::create_dir(path),
        Err(error) => Err(error),
    }
}

fn validate_relative(path: &str) -> io::Result<()> {
    if path.is_empty()
        || !Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        || path == RECEIPT
    {
        return Err(invalid("Invalid bundled skill path"));
    }
    Ok(())
}

fn check_file(root: &Path, relative: &str) -> io::Result<()> {
    validate_relative(relative)?;
    let mut path = root.to_path_buf();
    let components: Vec<_> = Path::new(relative).components().collect();
    for (index, component) in components.iter().enumerate() {
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(meta) if index + 1 == components.len() && meta.file_type().is_file() => {}
            Ok(meta) if index + 1 < components.len() && meta.file_type().is_dir() => {}
            Ok(_) => return Err(invalid("Bundled skill path has an unexpected file type")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let temporary = path.with_file_name(format!(".kodex-write-{}", uuid::Uuid::new_v4()));
    let result = fs::write(&temporary, contents).and_then(|_| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn install_skills(home: &Path, files: &[(&str, &str)]) -> io::Result<()> {
    regular_directory(&home.join("skills"))?;
    let root = home.join("skills/kodex-builtin");
    let existed = root.try_exists()?;
    let receipt = root.join(RECEIPT);
    let previous: BTreeSet<String> = if existed {
        regular_directory(&root)?;
        if !fs::symlink_metadata(&receipt)?.file_type().is_file() {
            return Err(invalid("Kodex skill receipt must be a regular file"));
        }
        serde_json::from_slice(&fs::read(&receipt)?).map_err(io::Error::other)?
    } else {
        // Publish directory and ownership together. Interrupted staging stays outside
        // skill discovery and cannot leave a half-owned destination blocking retries.
        let stage = home.join(format!(".kodex-skills-init-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&stage)?;
        let result = fs::write(stage.join(RECEIPT), b"[]").and_then(|_| fs::rename(&stage, &root));
        if result.is_err() {
            let _ = fs::remove_dir_all(&stage);
        }
        result?;
        BTreeSet::new()
    };
    let current: BTreeSet<String> = files.iter().map(|(path, _)| (*path).to_owned()).collect();
    for path in previous.union(&current) {
        check_file(&root, path)?;
    }
    for path in current.difference(&previous) {
        if root.join(path).exists() {
            return Err(invalid("Bundled skill would overwrite an unowned file"));
        }
    }
    // Record both inventories first so a failed update can safely resume or roll back.
    let union: BTreeSet<_> = previous.union(&current).collect();
    atomic_write(
        &receipt,
        &serde_json::to_vec(&union).map_err(io::Error::other)?,
    )?;
    for (relative, contents) in files {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap())?;
        if fs::read(&path).ok().as_deref() != Some(contents.as_bytes()) {
            atomic_write(&path, contents.as_bytes())?;
        }
    }
    for relative in previous.difference(&current) {
        let path = root.join(relative);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let mut parent = path.parent();
        while let Some(dir) = parent.filter(|dir| *dir != root) {
            if fs::remove_dir(dir).is_err() {
                break;
            }
            parent = dir.parent();
        }
    }
    atomic_write(
        &receipt,
        &serde_json::to_vec(&current).map_err(io::Error::other)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_manual_control_arguments_but_preserves_other_servers() {
        for args in [
            vec!["-c", "mcp_servers.kodex-control.url='foreign'"],
            vec!["--config", "mcp_servers.kodex-control.env={BAD='value'}"],
            vec!["--config=mcp_servers.kodex-control.enabled=false"],
            vec!["-cmcp_servers.kodex-control.command='foreign'"],
            vec!["-c=mcp_servers={kodex-control={command='foreign'}}"],
        ] {
            let mut command = tokio::process::Command::new("codex");
            command.args(args);
            assert!(reject_control_overrides(&command).is_err());
        }
        let mut command = tokio::process::Command::new("codex");
        command.args([
            "app-server",
            "-c",
            "mcp_servers.other.command='keep'",
            "--config=mcp_servers={other={command='keep'}}",
        ]);
        reject_control_overrides(&command).unwrap();
    }

    #[test]
    fn manual_server_collision_is_rejected_before_skill_installation() {
        let home = tempfile::tempdir().unwrap();
        let saved = "[mcp_servers.kodex-control]\ncommand='user-command'\n";
        fs::write(home.path().join("config.toml"), saved).unwrap();
        let mut command = tokio::process::Command::new("codex");
        let error = prepare(&mut command, home.path(), Path::new("/owned/gateway")).unwrap_err();
        assert!(error.to_string().contains("reserved"));
        assert_eq!(
            fs::read_to_string(home.path().join("config.toml")).unwrap(),
            saved
        );
        assert!(!home.path().join("skills").exists());
    }

    #[test]
    fn reconciles_bundle_and_preserves_user_skills() {
        let home = tempfile::tempdir().unwrap();
        let user = home.path().join("skills/user/SKILL.md");
        fs::create_dir_all(user.parent().unwrap()).unwrap();
        fs::write(&user, "user content").unwrap();
        let first = [("one/SKILL.md", "first"), ("two/SKILL.md", "second")];
        install_skills(home.path(), &first).unwrap();
        install_skills(home.path(), &first).unwrap();
        let root = home.path().join("skills/kodex-builtin");
        assert_eq!(
            fs::read_to_string(root.join("one/SKILL.md")).unwrap(),
            "first"
        );
        install_skills(home.path(), &[("two/SKILL.md", "updated")]).unwrap();
        assert!(!root.join("one/SKILL.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("two/SKILL.md")).unwrap(),
            "updated"
        );
        assert_eq!(fs::read_to_string(user).unwrap(), "user content");
        // A previous application version restores its own bundle on rollback.
        install_skills(home.path(), &first).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("two/SKILL.md")).unwrap(),
            "second"
        );
    }

    #[test]
    fn refuses_unowned_directory_without_modifying_it() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("skills/kodex-builtin");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("user.txt"), "keep").unwrap();
        assert!(install_skills(home.path(), &[("one/SKILL.md", "new")]).is_err());
        assert_eq!(fs::read_to_string(root.join("user.txt")).unwrap(), "keep");
        assert!(!root.join("one").exists());
    }

    #[test]
    fn interrupted_staging_does_not_block_fresh_install() {
        let home = tempfile::tempdir().unwrap();
        let abandoned = home.path().join(".kodex-skills-init-interrupted");
        fs::create_dir(&abandoned).unwrap();
        fs::write(abandoned.join(RECEIPT), "[").unwrap();
        install_skills(home.path(), &[("one/SKILL.md", "ready")]).unwrap();
        assert_eq!(
            fs::read_to_string(home.path().join("skills/kodex-builtin/one/SKILL.md")).unwrap(),
            "ready"
        );
    }

    #[test]
    fn partial_update_can_roll_back_without_removing_unowned_files() {
        let home = tempfile::tempdir().unwrap();
        install_skills(home.path(), &[("old/SKILL.md", "old")]).unwrap();
        let root = home.path().join("skills/kodex-builtin");
        // Receipt committed, only one replacement written before interruption.
        fs::write(
            root.join(RECEIPT),
            r#"["old/SKILL.md","new/SKILL.md","new/agents/openai.yaml"]"#,
        )
        .unwrap();
        fs::create_dir(root.join("new")).unwrap();
        fs::write(root.join("new/SKILL.md"), "partial").unwrap();
        fs::write(root.join("new/user.txt"), "keep").unwrap();
        install_skills(home.path(), &[("old/SKILL.md", "restored")]).unwrap();
        assert!(!root.join("new/SKILL.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("new/user.txt")).unwrap(),
            "keep"
        );
        assert_eq!(
            fs::read_to_string(root.join("old/SKILL.md")).unwrap(),
            "restored"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_skill_root() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join("skills")).unwrap();
        assert!(install_skills(home.path(), &[("one/SKILL.md", "new")]).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
}
