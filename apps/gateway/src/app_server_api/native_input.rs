//! Native UserInput stays owned by the pinned schema, including media variants.
use crate::error::{ApiError, ApiResult};
use jsonschema::JSONSchema;
use serde_json::Value;
use std::sync::LazyLock;

static INPUT_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    let native: Value = serde_json::from_str(include_str!(
        "../../app-server-schema/0.160.0/json/v2/ThreadQueueAddParams.json"
    ))
    .expect("pinned native input schema");
    inline_refs(&native["properties"]["input"], &native)
});
static INPUT_ITEM: LazyLock<JSONSchema> = LazyLock::new(|| {
    JSONSchema::compile(&INPUT_SCHEMA["items"]).expect("pinned native UserInput schema")
});

// Inline local references so both MCP and OpenAPI can embed the same native
// fragment without depending on their different definition namespaces.
fn inline_refs(value: &Value, root: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            if let Some(reference) = fields.get("$ref").and_then(Value::as_str) {
                return inline_refs(
                    root.pointer(reference.strip_prefix('#').expect("local native reference"))
                        .expect("native definition"),
                    root,
                );
            }
            Value::Object(
                fields
                    .iter()
                    .map(|(key, value)| (key.clone(), inline_refs(value, root)))
                    .collect(),
            )
        }
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| inline_refs(value, root))
                .collect(),
        ),
        value => value.clone(),
    }
}

pub(crate) fn mcp_schema(_: &mut rmcp::schemars::SchemaGenerator) -> rmcp::schemars::Schema {
    INPUT_SCHEMA
        .clone()
        .try_into()
        .expect("native input JSON schema")
}

pub(crate) fn openapi_schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
    let mut schema = INPUT_SCHEMA.clone();
    normalize_openapi(&mut schema);
    serde_json::from_value(schema).expect("native input OpenAPI schema")
}

// openapi-typescript otherwise loses anyOf locator fields beside properties,
// and turns optional fields with a default into required TypeScript properties.
fn normalize_openapi(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.remove("default");
            for field in fields.values_mut() {
                normalize_openapi(field);
            }
            if fields.contains_key("properties") && fields.contains_key("anyOf") {
                let alternatives = fields.remove("anyOf").unwrap();
                let common = Value::Object(std::mem::take(fields));
                *value = serde_json::json!({"allOf":[common,{"anyOf":alternatives}]});
            }
        }
        Value::Array(values) => values.iter_mut().for_each(normalize_openapi),
        _ => {}
    }
}

pub(crate) fn validate(input: &[Value]) -> ApiResult<()> {
    for (index, item) in input.iter().enumerate() {
        if !INPUT_ITEM.is_valid(item) {
            // Never include submitted text, paths or media in diagnostics.
            return Err(ApiError::BadRequest(format!(
                "input[{index}] must be a native UserInput object with a valid type and its required fields. For text use {{\"type\":\"text\",\"text\":\"your message\"}} inside the input array, not a plain string. No input was submitted; correct the arguments before submitting again."
            )));
        }
    }
    Ok(())
}
