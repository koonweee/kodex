//! Normalize explicit native tool-result image blocks, never text or arbitrary JSON.
use super::TimelineToolImage;
use serde_json::Value;

pub(super) fn images(item: &Value) -> Vec<TimelineToolImage> {
    let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
    let blocks = match kind {
        "mcpToolCall" => item.pointer("/result/content"),
        "dynamicToolCall" => item.get("contentItems"),
        _ => None,
    };
    blocks
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| {
            let url = match (kind, block.get("type").and_then(Value::as_str)?) {
                ("mcpToolCall", "image") => {
                    let mime = block.get("mimeType")?.as_str()?.trim().to_ascii_lowercase();
                    let data = block.get("data")?.as_str()?;
                    if !valid_image_mime(&mime) || data.is_empty() {
                        return None;
                    }
                    format!("data:{mime};base64,{data}")
                }
                ("dynamicToolCall", "inputImage") => block.get("imageUrl")?.as_str()?.to_owned(),
                _ => return None,
            };
            if !(url.starts_with("data:image/")
                || url.starts_with("https://")
                || url.starts_with("http://"))
            {
                return None;
            }
            Some(TimelineToolImage { url })
        })
        .collect()
}

// MIME essence only: avoid allowing data-URL delimiters in the media type.
fn valid_image_mime(mime: &str) -> bool {
    mime.strip_prefix("image/").is_some_and(|subtype| {
        !subtype.is_empty()
            && subtype
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte))
    })
}
