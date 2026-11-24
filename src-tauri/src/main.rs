// No console in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, UdpSocket};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tungstenite::Message;

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

type Peers = Arc<Mutex<Vec<(usize, Sender<Message>)>>>;

/// OpenStarship online: a WebSocket relay on the given port. Every text message a player sends is passed on to the
/// other connected players; the host's own page connects to it too, so both sides run the same client code.
/// Returns this computer's LAN address, to tell the other player.
#[tauri::command(async)]
fn mp_host(port: u16, state: tauri::State<'_, Mutex<Option<u16>>>) -> Result<String, String> {
    let mut running = state.lock().unwrap();
    if *running != Some(port) {
        let listener = TcpListener::bind(("0.0.0.0", port)).map_err(|e| e.to_string())?;
        *running = Some(port);
        let peers: Peers = Arc::new(Mutex::new(Vec::new()));
        std::thread::spawn(move || {
            for (id, stream) in listener.incoming().flatten().enumerate() {
                let peers = peers.clone();
                std::thread::spawn(move || client(id, stream, peers));
            }
        });
    }
    // The route the system would use to reach the internet gives the LAN address; no packet is sent.
    let ip = UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("8.8.8.8:80").and(s.local_addr()))
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into());
    Ok(format!("{ip}:{port}"))
}

fn client(id: usize, stream: std::net::TcpStream, peers: Peers) {
    let Ok(mut ws) = tungstenite::accept(stream) else { return };
    // A short read timeout lets this one thread both read the socket and write what the others relay.
    let _ = ws.get_ref().set_read_timeout(Some(Duration::from_millis(15)));
    let (tx, rx) = channel();
    peers.lock().unwrap().push((id, tx));
    'run: loop {
        match ws.read() {
            Ok(m @ Message::Text(_)) => {
                for (other, tx) in peers.lock().unwrap().iter() {
                    if *other != id {
                        let _ = tx.send(m.clone());
                    }
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
        while let Ok(m) = rx.try_recv() {
            if ws.send(m).is_err() {
                break 'run;
            }
        }
    }
    peers.lock().unwrap().retain(|(other, _)| *other != id);
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(None::<u16>))
        .invoke_handler(tauri::generate_handler![fetch_text, mp_host])
        .run(tauri::generate_context!())
        .expect("no se pudo iniciar OpenGISEarth");
}
