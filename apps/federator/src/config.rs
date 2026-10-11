use std::{env, net::SocketAddr, path::PathBuf};

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub sandbox_bind: SocketAddr,
    pub data_dir: PathBuf,
    pub database_path: PathBuf,
    pub frontend_dist: Option<PathBuf>,
    pub public_origin: String,
    pub sandbox_public_url: String,
}

impl Default for Config {
    fn default() -> Self {
        let data_dir = default_data_dir();
        Self {
            bind: "127.0.0.1:8787".parse().unwrap(),
            sandbox_bind: "127.0.0.1:8790".parse().unwrap(),
            database_path: data_dir.join("federator.db"),
            data_dir,
            frontend_dist: None,
            public_origin: "http://localhost:8787".to_string(),
            sandbox_public_url: "http://localhost:8790/app-surface-sandbox.html".to_string(),
        }
    }
}

impl Config {
    pub fn from_env() -> Self {
        let mut config = Self::default();
        if let Ok(bind) = env::var("KODEX_FEDERATOR_BIND") {
            config.bind = bind
                .parse()
                .unwrap_or_else(|error| panic!("invalid KODEX_FEDERATOR_BIND: {error}"));
        }
        if let Ok(bind) = env::var("KODEX_FEDERATOR_SANDBOX_BIND") {
            config.sandbox_bind = bind
                .parse()
                .unwrap_or_else(|error| panic!("invalid KODEX_FEDERATOR_SANDBOX_BIND: {error}"));
        }
        if let Some(data_dir) = env::var_os("KODEX_FEDERATOR_DATA_DIR") {
            config.data_dir = PathBuf::from(data_dir);
            config.database_path = config.data_dir.join("federator.db");
        }
        if let Some(path) = env::var_os("KODEX_FEDERATOR_DATABASE_PATH") {
            config.database_path = PathBuf::from(path);
        }
        if let Some(path) = env::var_os("KODEX_FRONTEND_DIST") {
            config.frontend_dist = Some(PathBuf::from(path));
        }
        if let Ok(url) = env::var("KODEX_FEDERATOR_SANDBOX_PUBLIC_URL") {
            config.sandbox_public_url = url;
        }
        if let Ok(url) = env::var("KODEX_FEDERATOR_PUBLIC_ORIGIN") {
            config.public_origin = url;
        }
        config
    }
}

fn default_data_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".kodex")
        .join("federated-v1")
        .join("federator")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_use_independent_federator_state_and_listeners() {
        let config = Config::default();
        assert_eq!(config.bind, "127.0.0.1:8787".parse().unwrap());
        assert_eq!(config.sandbox_bind, "127.0.0.1:8790".parse().unwrap());
        assert!(config.data_dir.ends_with(".kodex/federated-v1/federator"));
        assert_eq!(config.database_path, config.data_dir.join("federator.db"));
        assert_eq!(config.public_origin, "http://localhost:8787");
        assert_eq!(
            config.sandbox_public_url,
            "http://localhost:8790/app-surface-sandbox.html"
        );
    }
}
