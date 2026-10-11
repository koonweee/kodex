use utoipa::OpenApi;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", kodex_federator::ApiDoc::openapi().to_pretty_json()?);
    Ok(())
}
