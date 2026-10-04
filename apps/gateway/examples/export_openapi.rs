use utoipa::OpenApi;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", kodex_gateway::api::ApiDoc::openapi().to_json()?);
    Ok(())
}
