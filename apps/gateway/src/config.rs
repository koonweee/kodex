use std::{
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Config {
    pub instance: InstanceConfig,
    pub server: ServerConfig,
    pub codex: CodexConfig,
    pub database: DatabaseConfig,
    pub uploads: UploadsConfig,
    pub projects: ProjectsConfig,
    pub frontend: FrontendConfig,
    pub plugins: PluginConfig,
    pub notifications: NotificationsConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct InstanceConfig {
    pub data_dir: PathBuf,
    pub id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ServerConfig {
    pub bind: SocketAddr,
    pub trusted_network_only: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct CodexConfig {
    pub binary: String,
    pub args: Vec<String>,
    pub home: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct DatabaseConfig {
    pub path: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct UploadsConfig {
    pub dir: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ProjectsConfig {
    pub home_dir: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FrontendConfig {
    pub dist_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PluginConfig {
    pub kodex_control_marketplace_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct NotificationsConfig {
    pub vapid_public_key: Option<String>,
    pub vapid_private_key: Option<String>,
    pub vapid_subject: Option<String>,
    pub recheck_delay_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        let data_dir = default_data_dir();
        Self {
            instance: InstanceConfig {
                data_dir: data_dir.clone(),
                id: uuid::Uuid::new_v4().to_string(),
            },
            server: ServerConfig {
                bind: "127.0.0.1:8787"
                    .parse()
                    .expect("default bind address is valid"),
                trusted_network_only: true,
            },
            codex: CodexConfig {
                binary: "codex".to_string(),
                home: data_dir.join("codex-home"),
                args: vec![
                    "app-server".to_string(),
                    "--listen".to_string(),
                    "stdio://".to_string(),
                ],
            },
            database: DatabaseConfig {
                path: default_data_dir().join("gateway.db"),
            },
            uploads: UploadsConfig {
                dir: default_uploads_dir(),
            },
            projects: ProjectsConfig {
                home_dir: home_dir(),
            },
            frontend: FrontendConfig { dist_dir: None },
            plugins: PluginConfig {
                kodex_control_marketplace_path: None,
            },
            notifications: NotificationsConfig {
                vapid_public_key: None,
                vapid_private_key: None,
                vapid_subject: None,
                recheck_delay_ms: 2_000,
            },
        }
    }
}

impl Config {
    pub fn from_env() -> Self {
        let mut config = Self::default();

        if let Ok(bind) = env::var("KODEX_BIND") {
            config.server.bind = bind
                .parse()
                .unwrap_or_else(|err| panic!("invalid KODEX_BIND: {err}"));
        }

        if let Ok(path) = env::var("KODEX_DATABASE_PATH") {
            config.database.path = expand_home(path);
        }

        if let Ok(path) = env::var("KODEX_UPLOADS_DIR") {
            config.uploads.dir = expand_home(path);
        }

        if let Ok(binary) = env::var("KODEX_CODEX_BINARY") {
            config.codex.binary = binary;
        }

        if let Ok(args) = env::var("KODEX_CODEX_ARGS") {
            config.codex.args = args.split_whitespace().map(str::to_string).collect();
        }

        if let Ok(dist_dir) = env::var("KODEX_FRONTEND_DIST") {
            config.frontend.dist_dir = Some(expand_home(dist_dir));
        }

        if let Ok(path) = env::var("KODEX_KODEX_CONTROL_MARKETPLACE_PATH") {
            config.plugins.kodex_control_marketplace_path = Some(expand_home(path));
        }

        if let Ok(key) = env::var("KODEX_VAPID_PUBLIC_KEY") {
            config.notifications.vapid_public_key = Some(key);
        }
        if let Ok(key) = env::var("KODEX_VAPID_PRIVATE_KEY") {
            config.notifications.vapid_private_key = Some(key);
        }
        if let Ok(subject) = env::var("KODEX_VAPID_SUBJECT") {
            config.notifications.vapid_subject = Some(subject);
        }
        if let Ok(delay_ms) = env::var("KODEX_NOTIFICATIONS_RECHECK_DELAY_MS") {
            config.notifications.recheck_delay_ms = delay_ms.parse().unwrap_or_else(|err| {
                panic!("invalid KODEX_NOTIFICATIONS_RECHECK_DELAY_MS: {err}")
            });
        }

        config
    }
}

fn default_data_dir() -> PathBuf {
    env::var_os("KODEX_DATA_DIR")
        .map(PathBuf::from)
        .map(expand_home_path)
        .unwrap_or_else(|| home_dir().join(".kodex").join("native-v1"))
}

fn default_uploads_dir() -> PathBuf {
    env::temp_dir().join("kodex").join("uploads")
}

pub fn expand_home(path: impl AsRef<Path>) -> PathBuf {
    expand_home_path(path.as_ref().to_path_buf())
}

fn expand_home_path(path: PathBuf) -> PathBuf {
    let Some(path_str) = path.to_str() else {
        return path;
    };

    if path_str == "~" {
        return home_dir();
    }

    if let Some(rest) = path_str.strip_prefix("~/") {
        return home_dir().join(rest);
    }

    path
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_bind_is_localhost() {
        assert_eq!(
            Config::default().server.bind,
            "127.0.0.1:8787".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn default_database_lives_under_kodex_home() {
        let path = Config::default().database.path;
        assert!(path.ends_with(".kodex/native-v1/gateway.db"));
    }

    #[test]
    fn default_uploads_live_under_temp_dir() {
        let path = Config::default().uploads.dir;
        assert_eq!(path, std::env::temp_dir().join("kodex").join("uploads"));
    }
}
