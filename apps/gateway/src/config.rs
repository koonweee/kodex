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
    pub control_bind: SocketAddr,
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
                control_bind: "127.0.0.1:8788"
                    .parse()
                    .expect("default control bind address is valid"),
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

        let executor_bind_was_set = if let Ok(bind) = env::var("KODEX_BIND") {
            config.server.bind = bind
                .parse()
                .unwrap_or_else(|err| panic!("invalid KODEX_BIND: {err}"));
            true
        } else {
            false
        };

        if let Ok(bind) = env::var("KODEX_CONTROL_BIND") {
            config.server.control_bind = parse_control_bind(&bind);
        } else if executor_bind_was_set {
            config.server.control_bind = derived_control_bind(config.server.bind);
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

fn parse_control_bind(bind: &str) -> SocketAddr {
    let address = bind
        .parse::<SocketAddr>()
        .unwrap_or_else(|err| panic!("invalid KODEX_CONTROL_BIND: {err}"));
    assert!(
        address.ip().is_loopback(),
        "KODEX_CONTROL_BIND must use a loopback address"
    );
    address
}

fn derived_control_bind(executor: SocketAddr) -> SocketAddr {
    let port = executor
        .port()
        .checked_add(1)
        .expect("KODEX_BIND port 65535 requires an explicit KODEX_CONTROL_BIND");
    let ip = if executor.is_ipv6() {
        "[::1]"
    } else {
        "127.0.0.1"
    };
    format!("{ip}:{port}").parse().unwrap()
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
        assert_eq!(
            Config::default().server.control_bind,
            "127.0.0.1:8788".parse::<SocketAddr>().unwrap()
        );
        assert_ne!(
            Config::default().server.bind,
            Config::default().server.control_bind
        );
    }

    #[test]
    fn control_bind_rejects_non_loopback_addresses() {
        assert_eq!(
            parse_control_bind("127.0.0.1:9001"),
            "127.0.0.1:9001".parse().unwrap()
        );
        assert!(std::panic::catch_unwind(|| parse_control_bind("0.0.0.0:9001")).is_err());
        assert!(std::panic::catch_unwind(|| parse_control_bind("100.64.0.1:9001")).is_err());
    }

    #[test]
    fn control_bind_derives_from_a_custom_executor_port() {
        assert_eq!(
            derived_control_bind("127.0.0.1:8788".parse().unwrap()),
            "127.0.0.1:8789".parse().unwrap()
        );
        assert_eq!(
            derived_control_bind("[::]:9000".parse().unwrap()),
            "[::1]:9001".parse().unwrap()
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
