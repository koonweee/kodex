fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "{}",
        serde_json::to_string_pretty(&kodex_federator::federated_openapi())?
    );
    Ok(())
}
