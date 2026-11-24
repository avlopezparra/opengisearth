// No console in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Fetches a text resource for the web page from the open data feeds that browsers cannot reach directly
/// (they send no CORS headers). Only the listed hosts are allowed.
#[tauri::command(async)]
fn fetch_text(url: String) -> Result<String, String> {
    const ALLOWED: [&str; 3] = ["https://opendata.adsb.fi/", "https://api.adsb.lol/", "https://opensky-network.org/"];
    if !ALLOWED.iter().any(|p| url.starts_with(p)) {
        return Err("host not allowed".into());
    }
    ureq::get(&url)
        .set("User-Agent", "OpenGISEarth")
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![fetch_text])
        .run(tauri::generate_context!())
        .expect("no se pudo iniciar OpenGISEarth");
}
