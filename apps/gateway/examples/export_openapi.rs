fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", kodex_gateway::api::executor_openapi().to_json()?);
    Ok(())
}
