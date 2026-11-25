// No console in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{IpAddr, Ipv4Addr, TcpListener, UdpSocket};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tungstenite::Message;

/// UDP port where a hosting app answers "who is playing on this network?".
const DISCOVERY: u16 = 47777;
/// The question is longer than any answer (at most 34 bytes), so the answering side cannot be used to amplify traffic.
const QUERY_LEN: usize = 48;

/// The relay port in use and, once hosting, the answer the discovery thread gives ("OGE!port|pilot").
#[derive(Default)]
struct Host {
    port: Option<u16>,
    reply: Option<Arc<Mutex<String>>>,
}

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
/// It also answers the discovery question of the apps on the same network, so they find the game without typing an address.
/// Returns this computer's LAN address, to tell the other player.
#[tauri::command(async)]
fn mp_host(port: u16, name: Option<String>, state: tauri::State<'_, Mutex<Host>>) -> Result<String, String> {
    let mut host = state.lock().unwrap();
    if host.port != Some(port) {
        let listener = TcpListener::bind(("0.0.0.0", port)).map_err(|e| e.to_string())?;
        host.port = Some(port);
        let peers: Peers = Arc::new(Mutex::new(Vec::new()));
        std::thread::spawn(move || {
            for (id, stream) in listener.incoming().flatten().enumerate() {
                let peers = peers.clone();
                std::thread::spawn(move || client(id, stream, peers));
            }
        });
    }
    let reply = format!("OGE!{port}|{}", short(name.as_deref().unwrap_or("")));
    match &host.reply {
        Some(current) => *current.lock().unwrap() = reply,
        // If the discovery port is taken the game still works: the other player types the address.
        None => {
            if let Ok(sock) = UdpSocket::bind(("0.0.0.0", DISCOVERY)) {
                let shared = Arc::new(Mutex::new(reply));
                host.reply = Some(shared.clone());
                std::thread::spawn(move || beacon(sock, shared));
            }
        }
    }
    let ip = lan_ip().map_or("127.0.0.1".to_string(), |ip| ip.to_string());
    Ok(format!("{ip}:{port}"))
}

/// The games hosted on this network, each as "ip:port|pilot": asks by broadcast and listens for a second and a half.
#[tauri::command(async)]
fn mp_find() -> Result<Vec<String>, String> {
    let mut targets = vec![(Ipv4Addr::BROADCAST, DISCOVERY)];
    if let Some(ip) = lan_ip() {
        // The usual home network (/24) too, in case the plain broadcast leaves through another adapter (VPN, virtual machines).
        let o = ip.octets();
        targets.push((Ipv4Addr::new(o[0], o[1], o[2], 255), DISCOVERY));
    }
    find(&targets, Duration::from_millis(1500)).map_err(|e| e.to_string())
}

/// The route the system would use to reach the internet gives the LAN address; no packet is sent.
fn lan_ip() -> Option<Ipv4Addr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}

/// A pilot name fit for the discovery answer: no control characters, no field separator, at most 24 bytes.
fn short(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().filter(|c| !c.is_control() && *c != '|') {
        if out.len() + c.len_utf8() > 24 {
            break;
        }
        out.push(c);
    }
    out
}

/// Answers every discovery question with the current game.
fn beacon(sock: UdpSocket, reply: Arc<Mutex<String>>) {
    let mut buf = [0u8; 64];
    loop {
        match sock.recv_from(&mut buf) {
            Ok((n, from)) if n >= QUERY_LEN && buf.starts_with(b"OGE?") => {
                let answer = reply.lock().unwrap().clone();
                let _ = sock.send_to(answer.as_bytes(), from);
            }
            Ok(_) => {}
            // Windows reports here an earlier answer that could not be delivered: not a reason to stop.
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// Sends the discovery question to the targets and collects the answers that arrive within `wait`.
fn find(targets: &[(Ipv4Addr, u16)], wait: Duration) -> std::io::Result<Vec<String>> {
    let sock = UdpSocket::bind("0.0.0.0:0")?;
    sock.set_broadcast(true)?;
    sock.set_read_timeout(Some(Duration::from_millis(200)))?;
    let mut query = [0u8; QUERY_LEN];
    query[..4].copy_from_slice(b"OGE?");
    for target in targets {
        let _ = sock.send_to(&query, target);
    }
    let (end, mut found, mut buf) = (Instant::now() + wait, Vec::new(), [0u8; 64]);
    while Instant::now() < end {
        let Ok((n, from)) = sock.recv_from(&mut buf) else { continue };
        let Some(rest) = std::str::from_utf8(&buf[..n]).ok().and_then(|s| s.strip_prefix("OGE!")) else { continue };
        let (port, name) = rest.split_once('|').unwrap_or((rest, ""));
        if let Ok(port) = port.parse::<u16>() {
            let game = format!("{}:{port}|{name}", from.ip());
            if !found.contains(&game) {
                found.push(game);
            }
        }
    }
    Ok(found)
}

/// The three numbers of a version such as "v1.2.3": a missing or unreadable part counts as 0.
fn version(v: &str) -> [u32; 3] {
    let mut out = [0; 3];
    for (i, part) in v.trim().trim_start_matches(['v', 'V']).split('.').take(3).enumerate() {
        out[i] = part.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0);
    }
    out
}

/// Update check: this app's version when the given release tag is newer than it; nothing otherwise.
#[tauri::command]
fn newer_than_mine(tag: String) -> Option<&'static str> {
    let mine = env!("CARGO_PKG_VERSION");
    (version(&tag) > version(mine)).then_some(mine)
}

/// Opens the downloads page in the system browser. The address is fixed: nothing the page says is run.
#[tauri::command]
fn open_release() -> Result<(), String> {
    const URL: &str = "https://github.com/avlopezparra/opengisearth/releases/latest";
    let opener = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(opener).arg(URL).spawn().map(|_| ()).map_err(|e| e.to_string())
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
        .manage(Mutex::new(Host::default()))
        .invoke_handler(tauri::generate_handler![fetch_text, mp_host, mp_find, newer_than_mine, open_release])
        .run(tauri::generate_context!())
        .expect("no se pudo iniciar OpenGISEarth");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hosted_game_is_found() {
        let sock = UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = sock.local_addr().unwrap().port();
        let name = short("Ana|Luz\n y un nombre demasiado largo para caber");
        assert!(name.len() <= 24 && name.starts_with("AnaLuz y un"));
        std::thread::spawn(move || beacon(sock, Arc::new(Mutex::new(format!("OGE!7777|{name}")))));
        let found = find(&[(Ipv4Addr::LOCALHOST, port)], Duration::from_millis(500)).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].starts_with("127.0.0.1:7777|AnaLuz y un"));
    }

    #[test]
    fn versions_compare_by_number() {
        assert_eq!(version("v1.10.2"), [1, 10, 2]);
        assert!(version("v0.2") > version("0.1.9"));
        assert!(version("0.10.0") > version("0.9.9"));
        assert_eq!(version("V0.1.0-beta"), version("0.1.0"));
        assert!(newer_than_mine("v0.0.1".into()).is_none() && newer_than_mine("v999.0.0".into()).is_some());
    }
}
