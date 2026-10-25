//! Gateway-owned authentication for the local Mac desktop.
use des::cipher::{BlockCipherEncrypt, KeyInit};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use zeroize::Zeroizing;

pub(crate) mod clipboard;
mod config;
pub(crate) mod socket;
pub use config::DesktopConfig;

const VERSION: &[u8; 12] = b"RFB 003.008\n";

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    thiserror::Error,
    serde::Serialize,
    serde::Deserialize,
    utoipa::ToSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum DesktopFailure {
    #[error("Desktop is supported only on macOS.")]
    UnsupportedPlatform,
    #[error("Configure a Screen Sharing VNC password containing 1–8 printable ASCII characters.")]
    Configuration,
    #[error("Screen Sharing rejected the configured VNC password.")]
    Authentication,
    #[error("Enable VNC-password access in macOS Screen Sharing.")]
    PasswordAccessDisabled,
    #[error("Screen Sharing or the desktop viewer used an unsupported protocol.")]
    Protocol,
    #[error("The desktop connection was interrupted or is unavailable.")]
    Connection,
    #[error("The desktop connection timed out.")]
    Timeout,
}

// Only the reversed, zero-padded VNC key is retained, and it is erased on drop.
#[derive(Clone, PartialEq, Eq)]
pub struct DesktopPassword(Zeroizing<[u8; 8]>);
impl DesktopPassword {
    pub fn new(value: &str) -> Result<Self, DesktopFailure> {
        if value.is_empty()
            || value.len() > 8
            || !value.bytes().all(|b| b.is_ascii_graphic() || b == b' ')
        {
            return Err(DesktopFailure::Configuration);
        }
        let mut key = Zeroizing::new([0; 8]);
        for (destination, byte) in key.iter_mut().zip(value.bytes()) {
            // VNC uses the opposite DES bit ordering (RFC 6143 section 7.2.2).
            *destination = byte.reverse_bits();
        }
        Ok(Self(key))
    }

    fn response(&self, mut challenge: [u8; 16]) -> [u8; 16] {
        let cipher = des::Des::new_from_slice(self.0.as_ref()).expect("eight-byte VNC key");
        for chunk in challenge.chunks_exact_mut(8) {
            let mut block = des::cipher::Block::<des::Des>::default();
            block.copy_from_slice(chunk);
            cipher.encrypt_block(&mut block);
            chunk.copy_from_slice(&block);
        }
        challenge
    }
}
impl std::fmt::Debug for DesktopPassword {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DesktopPassword([redacted])")
    }
}

/// Authenticate the fixed local upstream, then splice at ClientInit. This owns
/// both streams so cancellation, EOF or failure always closes both directions.
pub async fn relay<B, U>(
    mut browser: B,
    mut upstream: U,
    password: &DesktopPassword,
    deadline: Duration,
) -> Result<(), DesktopFailure>
where
    B: AsyncRead + AsyncWrite + Unpin,
    U: AsyncRead + AsyncWrite + Unpin,
{
    tokio::time::timeout(deadline, async {
        authenticate(&mut upstream, password).await?;
        accept_viewer(&mut browser).await?;
        // Enforce shared access before forwarding ClientInit. An exclusive
        // request must never reach the Mac and disconnect another browser.
        if browser.read_u8().await? == 0 {
            return Err(DesktopFailure::Protocol);
        }
        upstream.write_all(&[1]).await?;
        upstream.flush().await?;
        Ok::<_, DesktopFailure>(())
    })
    .await
    .map_err(|_| DesktopFailure::Timeout)??;

    let (mut browser_read, mut browser_write) = tokio::io::split(browser);
    let (mut upstream_read, mut upstream_write) = tokio::io::split(upstream);
    // Unlike copy_bidirectional, a closed input does not leave the other
    // half running indefinitely. Tokio's copy buffers provide backpressure.
    tokio::select! {
        result = tokio::io::copy(&mut browser_read, &mut upstream_write) => { result?; }
        result = tokio::io::copy(&mut upstream_read, &mut browser_write) => { result?; }
    }
    Ok(())
}

async fn authenticate<U>(upstream: &mut U, password: &DesktopPassword) -> Result<(), DesktopFailure>
where
    U: AsyncRead + AsyncWrite + Unpin,
{
    let mut banner = [0; 12];
    upstream.read_exact(&mut banner).await?;
    if &banner != VERSION && &banner != b"RFB 003.889\n" {
        return Err(DesktopFailure::Protocol);
    }
    upstream.write_all(VERSION).await?;
    upstream.flush().await?;
    let count = upstream.read_u8().await? as usize;
    if count == 0 {
        return Err(DesktopFailure::Connection);
    }
    // A one-byte count bounds this list. Never parse or echo native failure
    // prose: only the gateway's stable error classification reaches clients.
    let mut methods = [0; 255];
    upstream.read_exact(&mut methods[..count]).await?;
    if !methods[..count].contains(&2) {
        return Err(DesktopFailure::PasswordAccessDisabled);
    }
    upstream.write_all(&[2]).await?;
    upstream.flush().await?;
    let mut challenge = [0; 16];
    upstream.read_exact(&mut challenge).await?;
    upstream.write_all(&password.response(challenge)).await?;
    upstream.flush().await?;
    if upstream.read_u32().await? != 0 {
        return Err(DesktopFailure::Authentication);
    }
    Ok(())
}

async fn accept_viewer<B>(browser: &mut B) -> Result<(), DesktopFailure>
where
    B: AsyncRead + AsyncWrite + Unpin,
{
    browser.write_all(VERSION).await?;
    browser.flush().await?;
    let mut banner = [0; 12];
    browser.read_exact(&mut banner).await?;
    if &banner != VERSION {
        return Err(DesktopFailure::Protocol);
    }
    browser.write_all(&[1, 1]).await?; // Count=1, security=None inside trusted WSS.
    browser.flush().await?;
    if browser.read_u8().await? != 1 {
        return Err(DesktopFailure::Protocol);
    }
    browser.write_all(&0_u32.to_be_bytes()).await?;
    browser.flush().await?;
    Ok(())
}

impl From<std::io::Error> for DesktopFailure {
    fn from(_: std::io::Error) -> Self {
        Self::Connection
    }
}

#[cfg(test)]
mod tests;
