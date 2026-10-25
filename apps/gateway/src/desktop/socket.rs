//! WebSocket framing for the authenticated desktop byte stream.
use super::{DesktopConfig, DesktopFailure};
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use std::{future::Future, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
};

pub(crate) async fn serve(socket: WebSocket, config: DesktopConfig) {
    run(socket, config, async {
        if !cfg!(target_os = "macos") {
            return Err(DesktopFailure::UnsupportedPlatform);
        }
        // This destination is deliberately not configurable through any request.
        TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, 5900))
            .await
            .map_err(Into::into)
    })
    .await;
}

async fn run<U, F>(socket: WebSocket, config: DesktopConfig, connect: F)
where
    U: AsyncRead + AsyncWrite + Unpin,
    F: Future<Output = Result<U, DesktopFailure>>,
{
    let (mut sink, mut source) = socket.split();
    let failure = {
        let (relay_stream, framed_stream) = tokio::io::duplex(64 * 1024);
        let (mut framed_read, mut framed_write) = tokio::io::split(framed_stream);
        let incoming = async {
            while let Some(message) = source.next().await {
                match message.map_err(|_| DesktopFailure::Connection)? {
                    Message::Binary(bytes) => framed_write.write_all(&bytes).await?,
                    Message::Close(_) => return Ok(()),
                    Message::Ping(_) | Message::Pong(_) => {}
                    Message::Text(_) => return Err(DesktopFailure::Protocol),
                }
            }
            Ok::<_, DesktopFailure>(())
        };
        let outgoing = async {
            let mut buffer = [0; 32 * 1024];
            loop {
                let count = framed_read.read(&mut buffer).await?;
                if count == 0 {
                    return Ok::<_, DesktopFailure>(());
                }
                sink.send(Message::Binary(buffer[..count].to_vec().into()))
                    .await
                    .map_err(|_| DesktopFailure::Connection)?;
            }
        };
        let attempt = async {
            let password = config.password()?;
            let upstream = tokio::time::timeout(Duration::from_secs(3), connect)
                .await
                .map_err(|_| DesktopFailure::Timeout)??;
            super::relay(relay_stream, upstream, password, Duration::from_secs(10)).await
        };
        // Separate reader/writer futures avoid head-of-line deadlocks under
        // bidirectional pressure. No detached pumps outlive this connection.
        tokio::pin!(incoming, outgoing, attempt);
        tokio::select! {
            result = &mut incoming => result.err(),
            result = &mut outgoing => Some(result.err().unwrap_or(DesktopFailure::Connection)),
            result = &mut attempt => {
                if result.is_ok() {
                    // Native EOF may leave the last screen bytes in the duplex
                    // buffer. Deliver that tail before the close frame. A slow
                    // or vanished browser cannot keep this drain alive forever.
                    let _ = tokio::time::timeout(Duration::from_secs(1), &mut outgoing).await;
                }
                Some(result.err().unwrap_or(DesktopFailure::Connection))
            },
        }
    };
    if let Some(error) = failure {
        // The generated enum is the close reason contract. No native prose,
        // credential or arbitrary network error is included. Private close
        // codes distinguish retryable transport errors from permanent errors.
        let code = if matches!(error, DesktopFailure::Connection | DesktopFailure::Timeout) {
            4500
        } else {
            4400
        };
        let reason = serde_json::to_string(&error)
            .expect("unit enum serializes")
            .into();
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            sink.send(Message::Close(Some(CloseFrame { code, reason }))),
        )
        .await;
    }
}

#[cfg(test)]
#[path = "socket_tests.rs"]
mod tests;
