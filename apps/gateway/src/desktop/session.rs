//! Read-only native console state. No CoreGraphics/display initialization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum DesktopConsoleState {
    Locked,
    Unlocked,
    Unknown,
}

pub(crate) fn read_console_state() -> DesktopConsoleState {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn kodex_console_lock_state() -> std::ffi::c_int;
        }
        match unsafe { kodex_console_lock_state() } {
            0 => DesktopConsoleState::Unlocked,
            1 => DesktopConsoleState::Locked,
            _ => DesktopConsoleState::Unknown,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        DesktopConsoleState::Unknown
    }
}
