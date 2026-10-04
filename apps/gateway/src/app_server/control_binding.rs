use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::Path,
};
use tokio::process::Command;

pub(super) const CONTROL_ENV: [&str; 3] = [
    "KODEX_GATEWAY_URL",
    "KODEX_GATEWAY_BINARY",
    "KODEX_ALLOW_REMOTE_SELF_CONTROL",
];

/// Bind managed MCP calls to this gateway, without changing the parent process.
/// Wildcard listeners are reached through loopback by their local native child.
pub(super) fn apply_control_binding(command: &mut Command, address: SocketAddr, binary: &Path) {
    let ip = match address.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    let local_address = SocketAddr::new(ip, address.port());
    command.env("KODEX_GATEWAY_URL", format!("http://{local_address}"));
    command.env("KODEX_GATEWAY_BINARY", binary);
    if !ip.is_loopback() {
        // An explicitly bound private interface belongs to this gateway. The
        // standalone CLI retains its explicit remote URL opt-in requirement.
        command.env("KODEX_ALLOW_REMOTE_SELF_CONTROL", "1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_control_binding_uses_reachable_local_address_and_owned_binary() {
        for (address, expected, remote) in [
            ("127.0.0.1:4001", "http://127.0.0.1:4001", false),
            ("0.0.0.0:4002", "http://127.0.0.1:4002", false),
            ("[::]:4003", "http://[::1]:4003", false),
            ("[::1]:4004", "http://[::1]:4004", false),
            ("100.64.1.2:4005", "http://100.64.1.2:4005", true),
        ] {
            let mut command = Command::new("fixture");
            for key in CONTROL_ENV {
                command.env_remove(key);
            }
            apply_control_binding(
                &mut command,
                address.parse().unwrap(),
                Path::new("/owned/gateway"),
            );
            let env = command
                .as_std()
                .get_envs()
                .collect::<std::collections::BTreeMap<_, _>>();
            assert_eq!(
                env[std::ffi::OsStr::new("KODEX_GATEWAY_URL")],
                Some(std::ffi::OsStr::new(expected))
            );
            assert_eq!(
                env[std::ffi::OsStr::new("KODEX_GATEWAY_BINARY")],
                Some(std::ffi::OsStr::new("/owned/gateway"))
            );
            assert_eq!(
                env[std::ffi::OsStr::new("KODEX_ALLOW_REMOTE_SELF_CONTROL")],
                remote.then_some(std::ffi::OsStr::new("1"))
            );
        }
    }
}
