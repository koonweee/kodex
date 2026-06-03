use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
};

use chrono::{DateTime, Duration as ChronoDuration, Utc};

pub const THREAD_VIEW_PRESENCE_TTL_SECONDS: i64 = 30;

pub fn thread_view_presence_ttl() -> ChronoDuration {
    ChronoDuration::seconds(THREAD_VIEW_PRESENCE_TTL_SECONDS)
}

#[derive(Clone, Default)]
pub struct ThreadPresence {
    inner: Arc<StdMutex<ThreadPresenceInner>>,
}

#[derive(Default)]
struct ThreadPresenceInner {
    clients: HashMap<String, ThreadPresenceRecord>,
}

#[derive(Clone)]
struct ThreadPresenceRecord {
    thread_id: String,
    last_seen_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadPresenceSnapshot {
    pub thread_id: String,
    pub foreground_viewer_count: usize,
    pub viewed: bool,
}

impl ThreadPresence {
    pub fn record_view(
        &self,
        client_id: &str,
        thread_id: &str,
        visible: bool,
    ) -> ThreadPresenceSnapshot {
        self.record_view_at(client_id, thread_id, visible, Utc::now())
    }

    pub fn record_view_at(
        &self,
        client_id: &str,
        thread_id: &str,
        visible: bool,
        now: DateTime<Utc>,
    ) -> ThreadPresenceSnapshot {
        let mut inner = self.inner.lock().unwrap();
        inner.prune_expired(now);
        if visible {
            inner.clients.insert(
                client_id.to_string(),
                ThreadPresenceRecord {
                    thread_id: thread_id.to_string(),
                    last_seen_at: now,
                },
            );
        } else if inner
            .clients
            .get(client_id)
            .is_some_and(|record| record.thread_id == thread_id)
        {
            inner.clients.remove(client_id);
        }
        inner.snapshot(thread_id, now)
    }

    pub fn foreground_viewer_count(&self, thread_id: &str) -> usize {
        self.foreground_viewer_count_at(thread_id, Utc::now())
    }

    pub fn foreground_viewer_count_at(&self, thread_id: &str, now: DateTime<Utc>) -> usize {
        let mut inner = self.inner.lock().unwrap();
        inner.prune_expired(now);
        inner.foreground_viewer_count(thread_id, now)
    }

    pub fn is_viewed(&self, thread_id: &str) -> bool {
        self.foreground_viewer_count(thread_id) > 0
    }
}

impl ThreadPresenceInner {
    fn prune_expired(&mut self, now: DateTime<Utc>) {
        self.clients
            .retain(|_, record| !is_expired(record.last_seen_at, now));
    }

    fn snapshot(&self, thread_id: &str, now: DateTime<Utc>) -> ThreadPresenceSnapshot {
        let foreground_viewer_count = self.foreground_viewer_count(thread_id, now);
        ThreadPresenceSnapshot {
            thread_id: thread_id.to_string(),
            foreground_viewer_count,
            viewed: foreground_viewer_count > 0,
        }
    }

    fn foreground_viewer_count(&self, thread_id: &str, now: DateTime<Utc>) -> usize {
        self.clients
            .values()
            .filter(|record| record.thread_id == thread_id && !is_expired(record.last_seen_at, now))
            .count()
    }
}

fn is_expired(last_seen_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    now.signed_duration_since(last_seen_at) > thread_view_presence_ttl()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_visible_clients_per_thread() {
        let presence = ThreadPresence::default();
        let now = Utc::now();

        let first = presence.record_view_at("client-1", "thread-1", true, now);
        let second = presence.record_view_at("client-2", "thread-1", true, now);
        presence.record_view_at("client-3", "thread-2", true, now);

        assert_eq!(first.foreground_viewer_count, 1);
        assert_eq!(second.foreground_viewer_count, 2);
        assert_eq!(presence.foreground_viewer_count_at("thread-1", now), 2);
        assert_eq!(presence.foreground_viewer_count_at("thread-2", now), 1);
    }

    #[test]
    fn hidden_clear_only_removes_matching_thread_for_client() {
        let presence = ThreadPresence::default();
        let now = Utc::now();

        presence.record_view_at("client-1", "thread-1", true, now);
        presence.record_view_at("client-1", "thread-2", false, now);
        assert_eq!(presence.foreground_viewer_count_at("thread-1", now), 1);

        let cleared = presence.record_view_at("client-1", "thread-1", false, now);
        assert_eq!(cleared.foreground_viewer_count, 0);
        assert!(!cleared.viewed);
    }

    #[test]
    fn client_switching_threads_clears_previous_thread() {
        let presence = ThreadPresence::default();
        let now = Utc::now();

        presence.record_view_at("client-1", "thread-1", true, now);
        presence.record_view_at("client-1", "thread-2", true, now);

        assert_eq!(presence.foreground_viewer_count_at("thread-1", now), 0);
        assert_eq!(presence.foreground_viewer_count_at("thread-2", now), 1);
    }

    #[test]
    fn expires_stale_clients() {
        let presence = ThreadPresence::default();
        let now = Utc::now();

        presence.record_view_at("client-1", "thread-1", true, now);

        assert_eq!(presence.foreground_viewer_count_at("thread-1", now), 1);
        assert_eq!(
            presence.foreground_viewer_count_at(
                "thread-1",
                now + thread_view_presence_ttl() + ChronoDuration::milliseconds(1),
            ),
            0
        );
    }
}
