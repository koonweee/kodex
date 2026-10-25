use super::*;
use axum::{extract::ws::WebSocketUpgrade, routing::get, Router};
use futures_util::{SinkExt, StreamExt};
use std::collections::VecDeque;
use tokio::{
    io::{duplex, AsyncReadExt, AsyncWriteExt, DuplexStream},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinHandle,
    time::{timeout, Duration},
};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

const LIMIT: Duration = Duration::from_secs(3);
const VERSION: &[u8] = b"RFB 003.008\n";

struct Server {
    url: String,
    connections: mpsc::UnboundedReceiver<DuplexStream>,
    task: JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn server() -> Server {
    let (sender, connections) = mpsc::unbounded_channel();
    let app = Router::new().route(
        "/",
        get(move |ws: WebSocketUpgrade| {
            let sender = sender.clone();
            async move {
                ws.on_upgrade(move |socket| async move {
                    let (gateway, mac) = duplex(4096);
                    sender.send(mac).unwrap();
                    run(socket, DesktopConfig::with_password("passwd"), async {
                        Ok(gateway)
                    })
                    .await;
                })
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Server {
        url,
        connections,
        task,
    }
}

struct Viewer {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    pending: VecDeque<u8>,
}
impl Viewer {
    async fn connect(url: &str) -> Self {
        let (socket, _) = connect_async(url).await.unwrap();
        Self {
            socket,
            pending: VecDeque::new(),
        }
    }
    async fn read(&mut self, count: usize) -> Vec<u8> {
        while self.pending.len() < count {
            match self.socket.next().await.unwrap().unwrap() {
                Message::Binary(bytes) => self.pending.extend(bytes),
                other => panic!("expected RFB bytes, got {other:?}"),
            }
        }
        self.pending.drain(..count).collect()
    }
    async fn send(&mut self, bytes: &[u8]) {
        self.socket
            .send(Message::Binary(bytes.to_vec().into()))
            .await
            .unwrap();
    }
    async fn init(&mut self, extra: &[u8]) {
        assert_eq!(self.read(12).await, VERSION);
        let mut bytes = VERSION.to_vec();
        bytes.extend([1, 1]); // Security selection and shared ClientInit.
        bytes.extend(extra);
        self.send(&bytes).await;
        assert_eq!(self.read(6).await, [1, 1, 0, 0, 0, 0]);
    }
    async fn failure(&mut self, code: u16, reason: &str) {
        loop {
            if let Message::Close(frame) = self.socket.next().await.unwrap().unwrap() {
                let frame = frame.unwrap();
                assert_eq!(u16::from(frame.code), code);
                assert_eq!(frame.reason, reason);
                return;
            }
        }
    }
}

async fn mac_auth(mac: &mut DuplexStream, success: bool) {
    mac.write_all(b"RFB 003.889\n").await.unwrap();
    let mut version = [0; 12];
    mac.read_exact(&mut version).await.unwrap();
    assert_eq!(&version, VERSION);
    mac.write_all(&[1, 2]).await.unwrap();
    assert_eq!(mac.read_u8().await.unwrap(), 2);
    mac.write_all(&(0..16).collect::<Vec<_>>()).await.unwrap();
    let mut response = [0; 16];
    mac.read_exact(&mut response).await.unwrap();
    assert_eq!(
        response,
        [
            0xe8, 0x39, 0x9b, 0x58, 0x57, 0x1e, 0x87, 0xed, 0x84, 0x45, 0xc8, 0x71, 0x6b, 0x6d,
            0xd9, 0x45
        ]
    );
    mac.write_all(&u32::from(!success).to_be_bytes())
        .await
        .unwrap();
}

#[tokio::test]
async fn binary_websocket_frames_relay_in_both_directions_without_password() {
    timeout(LIMIT, async {
        let mut server = server().await;
        let mut viewer = Viewer::connect(&server.url).await;
        let mut mac = server.connections.recv().await.unwrap();
        mac_auth(&mut mac, true).await;
        viewer.init(b"keys").await;
        assert_eq!(mac.read_u8().await.unwrap(), 1);
        let mut keys = [0; 4];
        mac.read_exact(&mut keys).await.unwrap();
        assert_eq!(&keys, b"keys");
        // Larger than the framing bridge's buffer: must stream without loss.
        let pixels = (0..150_000).map(|v| (v % 251) as u8).collect::<Vec<_>>();
        let expected = pixels.clone();
        let producer = tokio::spawn(async move {
            mac.write_all(&pixels).await.unwrap();
            mac
        });
        assert_eq!(viewer.read(expected.len()).await, expected);
        let mut mac = producer.await.unwrap();
        viewer.socket.close(None).await.unwrap();
        assert_eq!(mac.read(&mut [0]).await.unwrap(), 0);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn wrong_password_has_a_permanent_typed_close_and_no_rfb_admission() {
    timeout(LIMIT, async {
        let mut server = server().await;
        let mut viewer = Viewer::connect(&server.url).await;
        let mut mac = server.connections.recv().await.unwrap();
        mac_auth(&mut mac, false).await;
        viewer.failure(4400, "\"authentication\"").await;
        assert_eq!(mac.read(&mut [0]).await.unwrap(), 0);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn browser_close_cancels_stalled_upstream_authentication() {
    timeout(LIMIT, async {
        let mut server = server().await;
        let mut viewer = Viewer::connect(&server.url).await;
        let mut mac = server.connections.recv().await.unwrap();
        viewer.socket.close(None).await.unwrap();
        assert_eq!(mac.read(&mut [0]).await.unwrap(), 0);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_eof_is_retryable_and_one_viewer_close_does_not_end_another() {
    timeout(LIMIT, async {
        let mut server = server().await;
        let mut first = Viewer::connect(&server.url).await;
        let mut mac1 = server.connections.recv().await.unwrap();
        mac_auth(&mut mac1, true).await;
        first.init(&[]).await;
        assert_eq!(mac1.read_u8().await.unwrap(), 1);
        let mut second = Viewer::connect(&server.url).await;
        let mut mac2 = server.connections.recv().await.unwrap();
        mac_auth(&mut mac2, true).await;
        second.init(&[]).await;
        assert_eq!(mac2.read_u8().await.unwrap(), 1);
        first.socket.close(None).await.unwrap();
        assert_eq!(mac1.read(&mut [0]).await.unwrap(), 0);
        second.send(b"still-alive").await;
        let mut input = [0; 11];
        mac2.read_exact(&mut input).await.unwrap();
        assert_eq!(&input, b"still-alive");
        mac2.write_all(b"last-screen-frame").await.unwrap();
        drop(mac2);
        assert_eq!(second.read(17).await, b"last-screen-frame");
        second.failure(4500, "\"connection\"").await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn text_frames_are_rejected_and_close_the_native_socket() {
    timeout(LIMIT, async {
        let mut server = server().await;
        let mut viewer = Viewer::connect(&server.url).await;
        let mut mac = server.connections.recv().await.unwrap();
        viewer
            .socket
            .send(Message::Text("not-rfb".into()))
            .await
            .unwrap();
        viewer.failure(4400, "\"protocol\"").await;
        assert_eq!(mac.read(&mut [0]).await.unwrap(), 0);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn simultaneous_large_input_and_screen_updates_make_progress_under_backpressure() {
    timeout(LIMIT, async {
        let mut server = server().await;
        let mut viewer = Viewer::connect(&server.url).await;
        let mut mac = server.connections.recv().await.unwrap();
        mac_auth(&mut mac, true).await;
        let input = vec![42; 100_000];
        viewer.init(&input).await;
        assert_eq!(mac.read_u8().await.unwrap(), 1);
        let pixels = vec![91; 150_000];
        let expected = pixels.clone();
        let peer = tokio::spawn(async move {
            // Deliberately write all output before consuming the queued input.
            mac.write_all(&pixels).await.unwrap();
            let mut received = vec![0; input.len()];
            mac.read_exact(&mut received).await.unwrap();
            assert_eq!(received, input);
            mac.write_all(b"ack").await.unwrap();
            mac
        });
        assert_eq!(viewer.read(expected.len()).await, expected);
        assert_eq!(viewer.read(3).await, b"ack");
        let mut mac = peer.await.unwrap();
        viewer.socket.close(None).await.unwrap();
        assert_eq!(mac.read(&mut [0]).await.unwrap(), 0);
    })
    .await
    .unwrap();
}

/// Cross-stack proof using the built pinned iframe, a real browser/WebSocket,
/// this production adapter and a disposable native-auth peer. No port-5900 I/O.
#[tokio::test]
#[ignore = "requires apps/web npm install/build and Playwright bundled Chromium"]
async fn pinned_browser_crosses_gateway_authentication_boundary() {
    timeout(Duration::from_secs(45), async {
        let mut server = server().await;
        let web = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../web");
        let mut browser = tokio::process::Command::new("node");
        browser
            .current_dir(web)
            .arg("scripts/test-desktop-gateway.mjs")
            .arg(&server.url)
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let child = browser.spawn().unwrap();
        let mut mac = server.connections.recv().await.unwrap();
        mac_auth(&mut mac, true).await;
        assert_eq!(mac.read_u8().await.unwrap(), 1, "shared native ClientInit");
        let mut init = vec![0, 0, 0, 0];
        init[..2].copy_from_slice(&320_u16.to_be_bytes());
        init[2..].copy_from_slice(&200_u16.to_be_bytes());
        init.extend([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
        init.extend(4_u32.to_be_bytes());
        init.extend(b"Mock");
        mac.write_all(&init).await.unwrap();
        let mut painted = false;
        let mut keys = Vec::new();
        loop {
            let mut kind = [0];
            if mac.read(&mut kind).await.unwrap() == 0 {
                break;
            }
            match kind[0] {
                0 => {
                    let mut rest = [0; 19];
                    mac.read_exact(&mut rest).await.unwrap();
                }
                2 => {
                    mac.read_u8().await.unwrap();
                    let count = mac.read_u16().await.unwrap();
                    let mut encodings = vec![0; usize::from(count) * 4];
                    mac.read_exact(&mut encodings).await.unwrap();
                }
                3 => {
                    let mut request = [0; 9];
                    mac.read_exact(&mut request).await.unwrap();
                    if !painted {
                        let mut frame = vec![0; 16 + 320 * 200 * 4];
                        frame[2..4].copy_from_slice(&1_u16.to_be_bytes());
                        frame[8..10].copy_from_slice(&320_u16.to_be_bytes());
                        frame[10..12].copy_from_slice(&200_u16.to_be_bytes());
                        for pixel in frame[16..].chunks_exact_mut(4) {
                            pixel.copy_from_slice(&[0x11, 0x22, 0xcc, 0]);
                        }
                        mac.write_all(&frame).await.unwrap();
                        painted = true;
                    }
                }
                4 => {
                    let down = mac.read_u8().await.unwrap() == 1;
                    mac.read_u16().await.unwrap();
                    let key = mac.read_u32().await.unwrap();
                    keys.push((down, key));
                }
                5 => {
                    let mut pointer = [0; 5];
                    mac.read_exact(&mut pointer).await.unwrap();
                }
                other => panic!("unexpected client message {other}"),
            }
        }
        let output = child.wait_with_output().await.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(painted);
        assert_eq!(
            keys,
            [
                (true, 0xff1b),
                (false, 0xff1b),
                (true, 0xffeb),
                (true, 0x76),
                (false, 0x76),
                (false, 0xffeb)
            ]
        );
        println!("{}", String::from_utf8_lossy(&output.stdout));
    })
    .await
    .expect("bounded combined browser/gateway proof");
}
