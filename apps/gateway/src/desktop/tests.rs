use super::*;
use tokio::{
    io::{duplex, AsyncReadExt, AsyncWriteExt, DuplexStream},
    time::timeout,
};

const VERSION: &[u8; 12] = b"RFB 003.008\n";
const CHALLENGE_RESPONSE: [u8; 16] = [
    0xe8, 0x39, 0x9b, 0x58, 0x57, 0x1e, 0x87, 0xed, 0x84, 0x45, 0xc8, 0x71, 0x6b, 0x6d, 0xd9, 0x45,
]; // Independent OpenSSL DES-ECB vector: password "passwd", challenge bytes 0..15.
const DEADLINE: Duration = Duration::from_secs(2);

async fn bytes(stream: &mut DuplexStream, count: usize) -> Vec<u8> {
    let mut bytes = vec![0; count];
    stream.read_exact(&mut bytes).await.unwrap();
    bytes
}

async fn mac_auth(stream: &mut DuplexStream, fragmented: bool, success: bool) {
    mac_auth_with_trailing(stream, fragmented, success, &[]).await;
}

async fn mac_auth_with_trailing(
    stream: &mut DuplexStream,
    fragmented: bool,
    success: bool,
    trailing: &[u8],
) {
    if fragmented {
        for byte in b"RFB 003.889\n" {
            stream.write_all(&[*byte]).await.unwrap();
            tokio::task::yield_now().await;
        }
    } else {
        stream.write_all(VERSION).await.unwrap();
    }
    assert_eq!(bytes(stream, 12).await, VERSION);
    // Server preference includes account auth first; gateway must choose password auth.
    for byte in [3, 30, 2, 1] {
        stream.write_all(&[byte]).await.unwrap();
        if fragmented {
            tokio::task::yield_now().await;
        }
    }
    assert_eq!(bytes(stream, 1).await, [2]);
    for value in 0..16 {
        stream.write_all(&[value]).await.unwrap();
        if fragmented {
            tokio::task::yield_now().await;
        }
    }
    assert_eq!(bytes(stream, 16).await, CHALLENGE_RESPONSE);
    let mut result = u32::from(!success).to_be_bytes().to_vec();
    if !success {
        // Native prose may contain private values and claim an enormous size.
        // The gateway must classify failure without parsing or relaying it.
        result.extend(u32::MAX.to_be_bytes());
        result.extend(b"native-private-reason");
    }
    result.extend(trailing);
    if fragmented {
        for byte in result {
            stream.write_all(&[byte]).await.unwrap();
            tokio::task::yield_now().await;
        }
    } else {
        stream.write_all(&result).await.unwrap();
    }
}

async fn browser_auth(stream: &mut DuplexStream, shared: u8, extra: &[u8]) {
    assert_eq!(bytes(stream, 12).await, VERSION);
    // Pipeline frames to exercise preserving bytes past each handshake boundary.
    let mut request = VERSION.to_vec();
    request.extend([1, shared]);
    request.extend(extra);
    stream.write_all(&request).await.unwrap();
    assert_eq!(bytes(stream, 2).await, [1, 1]); // Only security type None.
    assert_eq!(bytes(stream, 4).await, [0; 4]);
}

#[test]
fn password_validation_does_not_silently_truncate_or_expose_secrets() {
    for invalid in ["", "123456789", "é", "a\nb", "a\0b"] {
        assert!(
            DesktopPassword::new(invalid).is_err(),
            "invalid password accepted"
        );
    }
    let password = DesktopPassword::new("passwd").unwrap();
    assert!(!format!("{password:?}").contains("passwd"));
}

#[tokio::test]
async fn fragmented_mac_auth_and_coalesced_browser_init_relay_bytes_and_close_both_sides() {
    timeout(DEADLINE, async {
        let (mut browser, gateway_browser) = duplex(256);
        let (gateway_mac, mut mac) = duplex(256);
        let task = tokio::spawn(async move {
            relay(
                gateway_browser,
                gateway_mac,
                &DesktopPassword::new("passwd").unwrap(),
                DEADLINE,
            )
            .await
        });
        let server = tokio::spawn(async move {
            mac_auth(&mut mac, true, true).await;
            assert_eq!(bytes(&mut mac, 1).await, [1]);
            mac.write_all(b"server-init-and-pixels").await.unwrap();
            assert_eq!(bytes(&mut mac, 10).await, b"key-events");
            mac.write_all(b"ack").await.unwrap();
            assert_eq!(
                mac.read(&mut [0]).await.unwrap(),
                0,
                "upstream leaked after viewer close"
            );
        });
        browser_auth(&mut browser, 1, b"key-events").await;
        assert_eq!(bytes(&mut browser, 25).await, b"server-init-and-pixelsack");
        drop(browser);
        assert_eq!(task.await.unwrap(), Ok(()));
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn failed_authentication_never_admits_browser_or_exposes_native_reason() {
    let (mut browser, gateway_browser) = duplex(128);
    let (gateway_mac, mut mac) = duplex(128);
    let task = tokio::spawn(async move {
        relay(
            gateway_browser,
            gateway_mac,
            &DesktopPassword::new("passwd").unwrap(),
            DEADLINE,
        )
        .await
    });
    mac_auth(&mut mac, false, false).await;
    assert_eq!(task.await.unwrap(), Err(DesktopFailure::Authentication));
    assert_eq!(browser.read(&mut [0; 16]).await.unwrap(), 0);
}

#[tokio::test]
async fn disabled_password_access_does_not_fall_back_to_none_or_account_login() {
    let (mut browser, gateway_browser) = duplex(128);
    let (gateway_mac, mut mac) = duplex(128);
    let task = tokio::spawn(async move {
        relay(
            gateway_browser,
            gateway_mac,
            &DesktopPassword::new("passwd").unwrap(),
            DEADLINE,
        )
        .await
    });
    mac.write_all(b"RFB 003.889\n").await.unwrap();
    assert_eq!(bytes(&mut mac, 12).await, VERSION);
    mac.write_all(&[3, 30, 33, 1]).await.unwrap();
    assert_eq!(
        task.await.unwrap(),
        Err(DesktopFailure::PasswordAccessDisabled)
    );
    assert_eq!(mac.read(&mut [0]).await.unwrap(), 0);
    assert_eq!(browser.read(&mut [0]).await.unwrap(), 0);
}

#[tokio::test]
async fn exclusive_viewer_cannot_disconnect_other_native_clients() {
    let (mut browser, gateway_browser) = duplex(128);
    let (gateway_mac, mut mac) = duplex(128);
    let task = tokio::spawn(async move {
        relay(
            gateway_browser,
            gateway_mac,
            &DesktopPassword::new("passwd").unwrap(),
            DEADLINE,
        )
        .await
    });
    mac_auth(&mut mac, false, true).await;
    browser_auth(&mut browser, 0, b"must-not-reach-mac").await;
    assert_eq!(task.await.unwrap(), Err(DesktopFailure::Protocol));
    assert_eq!(mac.read(&mut [0; 32]).await.unwrap(), 0);
}

#[tokio::test]
async fn upstream_disconnect_closes_the_viewer() {
    let (mut browser, gateway_browser) = duplex(128);
    let (gateway_mac, mut mac) = duplex(128);
    let task = tokio::spawn(async move {
        relay(
            gateway_browser,
            gateway_mac,
            &DesktopPassword::new("passwd").unwrap(),
            DEADLINE,
        )
        .await
    });
    mac_auth(&mut mac, false, true).await;
    browser_auth(&mut browser, 1, &[]).await;
    assert_eq!(bytes(&mut mac, 1).await, [1]);
    drop(mac);
    assert_eq!(timeout(DEADLINE, task).await.unwrap().unwrap(), Ok(()));
    assert_eq!(browser.read(&mut [0]).await.unwrap(), 0);
}

#[tokio::test]
async fn upstream_and_downstream_handshakes_have_one_bounded_deadline() {
    for stalled_browser in [false, true] {
        let (_browser, gateway_browser) = duplex(128);
        let (gateway_mac, mut mac) = duplex(128);
        let task = tokio::spawn(async move {
            relay(
                gateway_browser,
                gateway_mac,
                &DesktopPassword::new("passwd").unwrap(),
                Duration::from_millis(30),
            )
            .await
        });
        if stalled_browser {
            mac_auth(&mut mac, false, true).await;
        }
        assert_eq!(
            timeout(DEADLINE, task).await.unwrap().unwrap(),
            Err(DesktopFailure::Timeout)
        );
        assert_eq!(mac.read(&mut [0]).await.unwrap(), 0);
    }
}

#[tokio::test]
async fn malformed_upstream_protocol_is_rejected_without_responding() {
    let (_browser, gateway_browser) = duplex(128);
    let (gateway_mac, mut mac) = duplex(128);
    let task = tokio::spawn(async move {
        relay(
            gateway_browser,
            gateway_mac,
            &DesktopPassword::new("passwd").unwrap(),
            DEADLINE,
        )
        .await
    });
    mac.write_all(b"not-an-rfb!!").await.unwrap();
    assert_eq!(task.await.unwrap(), Err(DesktopFailure::Protocol));
    assert_eq!(mac.read(&mut [0]).await.unwrap(), 0);
}

#[tokio::test]
async fn upstream_coalesced_result_and_init_survive_the_splice() {
    timeout(DEADLINE, async {
        let (mut browser, gateway_browser) = duplex(128);
        let (gateway_mac, mut mac) = duplex(128);
        let task = tokio::spawn(async move {
            relay(
                gateway_browser,
                gateway_mac,
                &DesktopPassword::new("passwd").unwrap(),
                DEADLINE,
            )
            .await
        });
        // An over-eager fixture puts post-auth data in the same transport write
        // as SecurityResult. Exact reads must preserve those buffered bytes.
        mac_auth_with_trailing(&mut mac, false, true, b"server-init").await;
        browser_auth(&mut browser, 255, &[]).await;
        assert_eq!(bytes(&mut mac, 1).await, [1]);
        assert_eq!(bytes(&mut browser, 11).await, b"server-init");
        drop(browser);
        assert_eq!(task.await.unwrap(), Ok(()));
        assert_eq!(mac.read(&mut [0]).await.unwrap(), 0);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_negotiation_failure_is_transient_not_missing_password_access() {
    let (_browser, gateway_browser) = duplex(128);
    let (gateway_mac, mut mac) = duplex(128);
    let task = tokio::spawn(async move {
        relay(
            gateway_browser,
            gateway_mac,
            &DesktopPassword::new("passwd").unwrap(),
            DEADLINE,
        )
        .await
    });
    mac.write_all(VERSION).await.unwrap();
    assert_eq!(bytes(&mut mac, 12).await, VERSION);
    mac.write_all(&[0, 255, 255, 255, 255]).await.unwrap();
    assert_eq!(
        timeout(DEADLINE, task).await.unwrap().unwrap(),
        Err(DesktopFailure::Connection)
    );
}

#[tokio::test]
async fn cancelling_relay_drops_both_connections_even_during_authentication() {
    for authenticated in [false, true] {
        timeout(DEADLINE, async {
            let (mut browser, gateway_browser) = duplex(128);
            let (gateway_mac, mut mac) = duplex(128);
            let task = tokio::spawn(async move {
                relay(
                    gateway_browser,
                    gateway_mac,
                    &DesktopPassword::new("passwd").unwrap(),
                    DEADLINE,
                )
                .await
            });
            if authenticated {
                mac_auth(&mut mac, false, true).await;
                browser_auth(&mut browser, 1, &[]).await;
                assert_eq!(bytes(&mut mac, 1).await, [1]);
            }
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            assert_eq!(mac.read(&mut [0]).await.unwrap(), 0);
            assert_eq!(browser.read(&mut [0]).await.unwrap(), 0);
        })
        .await
        .unwrap();
    }
}
