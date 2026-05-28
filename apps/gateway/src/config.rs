use std::{
    env,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Config {
    pub server: ServerConfig,
    pub codex: CodexConfig,
    pub database: DatabaseConfig,
    pub uploads: UploadsConfig,
    pub projects: ProjectsConfig,
    pub frontend: FrontendConfig,
    pub previews: PreviewConfig,
    pub plugins: PluginConfig,
    pub notifications: NotificationsConfig,
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
pub struct PreviewConfig {
    pub caddy_binary: String,
    pub bind: Option<IpAddr>,
    pub port_range_start: u16,
    pub port_range_end: u16,
    pub caddy_admin_bind: SocketAddr,
    pub data_dir: PathBuf,
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
    pub apns_team_id: Option<String>,
    pub apns_key_id: Option<String>,
    pub apns_private_key_path: Option<PathBuf>,
    pub recheck_delay_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: ServerConfig {
                bind: "127.0.0.1:8787"
                    .parse()
                    .expect("default bind address is valid"),
                trusted_network_only: true,
            },
            codex: CodexConfig {
                binary: "codex".to_string(),
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
            previews: PreviewConfig {
                caddy_binary: "caddy".to_string(),
                bind: None,
                port_range_start: 10000,
                port_range_end: 19999,
                caddy_admin_bind: "127.0.0.1:20191"
                    .parse()
                    .expect("default caddy admin bind is valid"),
                data_dir: default_data_dir().join("previews"),
            },
            plugins: PluginConfig {
                kodex_control_marketplace_path: None,
            },
            notifications: NotificationsConfig {
                vapid_public_key: None,
                vapid_private_key: None,
                vapid_subject: None,
                apns_team_id: None,
                apns_key_id: None,
                apns_private_key_path: None,
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

        if let Ok(binary) = env::var("KODEX_CADDY_BINARY") {
            config.previews.caddy_binary = binary;
        }

        if let Ok(bind) = env::var("KODEX_PREVIEW_BIND") {
            config.previews.bind = Some(
                bind.parse()
                    .unwrap_or_else(|err| panic!("invalid KODEX_PREVIEW_BIND: {err}")),
            );
        }

        if let Ok(range) = env::var("KODEX_PREVIEW_PORT_RANGE") {
            let (start, end) = parse_port_range(&range)
                .unwrap_or_else(|err| panic!("invalid KODEX_PREVIEW_PORT_RANGE: {err}"));
            config.previews.port_range_start = start;
            config.previews.port_range_end = end;
        }

        if let Ok(bind) = env::var("KODEX_CADDY_ADMIN_BIND") {
            config.previews.caddy_admin_bind = bind
                .parse()
                .unwrap_or_else(|err| panic!("invalid KODEX_CADDY_ADMIN_BIND: {err}"));
        }
        validate_caddy_admin_bind(config.previews.caddy_admin_bind)
            .unwrap_or_else(|err| panic!("invalid KODEX_CADDY_ADMIN_BIND: {err}"));

        if let Ok(path) = env::var("KODEX_PREVIEW_DATA_DIR") {
            config.previews.data_dir = expand_home(path);
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
        if let Ok(team_id) = env::var("KODEX_APNS_TEAM_ID") {
            config.notifications.apns_team_id = Some(team_id);
        }
        if let Ok(key_id) = env::var("KODEX_APNS_KEY_ID") {
            config.notifications.apns_key_id = Some(key_id);
        }
        if let Ok(path) = env::var("KODEX_APNS_PRIVATE_KEY_PATH") {
            config.notifications.apns_private_key_path = Some(expand_home(path));
        }
        if let Ok(delay_ms) = env::var("KODEX_NOTIFICATIONS_RECHECK_DELAY_MS") {
            config.notifications.recheck_delay_ms = delay_ms.parse().unwrap_or_else(|err| {
                panic!("invalid KODEX_NOTIFICATIONS_RECHECK_DELAY_MS: {err}")
            });
        }

        config
    }

    pub fn preview_bind_address(&self) -> anyhow::Result<IpAddr> {
        if let Some(bind) = self.previews.bind {
            return Ok(bind);
        }

        let gateway_ip = self.server.bind.ip();
        if gateway_ip.is_unspecified() {
            anyhow::bail!(
                "KODEX_PREVIEW_BIND is required when KODEX_BIND uses an unspecified address"
            );
        }
        Ok(gateway_ip)
    }
}

fn parse_port_range(value: &str) -> Result<(u16, u16), String> {
    let Some((start, end)) = value.split_once('-') else {
        return Err("expected START-END".to_string());
    };
    let start = start
        .parse::<u16>()
        .map_err(|error| format!("invalid start port: {error}"))?;
    let end = end
        .parse::<u16>()
        .map_err(|error| format!("invalid end port: {error}"))?;
    if start == 0 || end == 0 || start > end {
        return Err("port range must be ascending non-zero ports".to_string());
    }
    Ok((start, end))
}

fn validate_caddy_admin_bind(value: SocketAddr) -> Result<(), String> {
    if !value.ip().is_loopback() {
        return Err("must use a loopback address".to_string());
    }
    Ok(())
}

fn default_data_dir() -> PathBuf {
    env::var_os("KODEX_DATA_DIR")
        .map(PathBuf::from)
        .map(expand_home_path)
        .unwrap_or_else(|| home_dir().join(".kodex"))
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
        assert!(path.ends_with(".kodex/gateway.db"));
    }

    #[test]
    fn default_uploads_live_under_temp_dir() {
        let path = Config::default().uploads.dir;
        assert_eq!(path, std::env::temp_dir().join("kodex").join("uploads"));
    }

    #[test]
    fn preview_bind_defaults_to_concrete_gateway_bind() {
        assert_eq!(
            Config::default().preview_bind_address().unwrap(),
            "127.0.0.1".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn preview_bind_requires_override_for_unspecified_gateway_bind() {
        let mut config = Config::default();
        config.server.bind = "0.0.0.0:8787".parse().unwrap();
        assert!(config.preview_bind_address().is_err());
        config.previews.bind = Some("100.64.0.10".parse().unwrap());
        assert_eq!(
            config.preview_bind_address().unwrap(),
            "100.64.0.10".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn preview_port_range_parser_rejects_invalid_ranges() {
        assert_eq!(parse_port_range("10000-19999").unwrap(), (10000, 19999));
        assert!(parse_port_range("19999-10000").is_err());
        assert!(parse_port_range("0-1").is_err());
        assert!(parse_port_range("10000").is_err());
    }

    #[test]
    fn caddy_admin_bind_must_be_loopback() {
        validate_caddy_admin_bind("127.0.0.1:20191".parse().unwrap()).unwrap();
        validate_caddy_admin_bind("[::1]:20191".parse().unwrap()).unwrap();
        assert!(validate_caddy_admin_bind("0.0.0.0:20191".parse().unwrap()).is_err());
        assert!(validate_caddy_admin_bind("100.64.0.10:20191".parse().unwrap()).is_err());
    }
}
