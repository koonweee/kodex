use axum::{routing::get, Router};

use crate::api::AppState;

pub use crate::events::{events, EventListResponse, EventsQuery};

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/events", get(events))
}
