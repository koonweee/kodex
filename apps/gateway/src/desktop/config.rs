use super::{DesktopFailure, DesktopPassword};

/// Environment-only configuration. This type deliberately has no serde
/// implementation; Config skips it for both serialization and deserialization.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DesktopConfig {
    password: Option<Result<DesktopPassword, DesktopFailure>>,
}

impl DesktopConfig {
    pub fn with_password(value: &str) -> Self {
        Self {
            // Retain neither plaintext nor invalid input. An invalid nonempty
            // setting is configured, but reports a permanent connection error.
            password: (!value.is_empty()).then(|| DesktopPassword::new(value)),
        }
    }

    pub fn configured(&self) -> bool {
        self.password.is_some()
    }

    pub fn password(&self) -> Result<&DesktopPassword, DesktopFailure> {
        match self.password.as_ref() {
            Some(Ok(password)) => Ok(password),
            Some(Err(error)) => Err(*error),
            None => Err(DesktopFailure::Configuration),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_and_empty_are_disabled_and_invalid_settings_never_panic() {
        assert!(!DesktopConfig::default().configured());
        assert!(!DesktopConfig::with_password("").configured());
        let invalid = DesktopConfig::with_password("a-password-too-long");
        assert!(invalid.configured());
        assert_eq!(
            invalid.password().unwrap_err(),
            DesktopFailure::Configuration
        );
        assert!(!format!("{invalid:?}").contains("too-long"));
        assert!(invalid
            .password()
            .unwrap_err()
            .to_string()
            .contains("1–8 printable ASCII"));
    }

    #[test]
    fn configuration_round_trips_never_include_a_desktop_secret() {
        let mut config = crate::config::Config::default();
        config.desktop = DesktopConfig::with_password("fixture1");
        assert!(config.desktop.configured());
        assert!(config.desktop.password().is_ok());
        assert!(!format!("{config:?}").contains("fixture1"));
        let value = serde_json::to_value(&config).unwrap();
        assert!(value.get("desktop").is_none());
        assert!(!value.to_string().contains("fixture1"));
        let restored: crate::config::Config = serde_json::from_value(value).unwrap();
        assert!(!restored.desktop.configured());
    }
}

#[cfg(test)]
mod environment_tests {
    use crate::config::Config;

    #[test]
    fn environment_loads_desktop_secret_without_serializing_it() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "desktop::config::environment_tests::isolated_environment_child",
                "--ignored",
            ])
            .env_clear()
            .env("KODEX_VNC_PASSWORD", "fixture1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
    }

    #[test]
    #[ignore = "invoked by parent with an isolated synthetic credential"]
    fn isolated_environment_child() {
        let config = Config::from_env();
        assert!(config.desktop.configured());
        assert!(config.desktop.password().is_ok());
        assert!(!format!("{config:?}").contains("fixture1"));
        assert!(!serde_json::to_string(&config).unwrap().contains("fixture1"));
        // Loading configuration never consumes or changes the parent process env.
        assert_eq!(std::env::var("KODEX_VNC_PASSWORD").unwrap(), "fixture1");
    }
}
