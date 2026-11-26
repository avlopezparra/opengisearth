// No console in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use tauri::Manager;
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

/// The requests of the MCP server that wait for the page's answer, by their number.
type Pending = Arc<Mutex<HashMap<u64, Sender<String>>>>;

/// The MCP server: an HTTP endpoint on this computer only. It knows nothing of the protocol: every JSON-RPC message an AI
/// assistant posts is handed to the page (web/mcp.js), and what the page replies is sent back.
#[derive(Default)]
struct Mcp {
    stop: Option<Arc<AtomicBool>>,
    url: String,
    token: Arc<Mutex<String>>,
    pending: Pending,
}

/// A token is 16 to 64 letters and digits: nothing that could break out of a header.
fn token_ok(token: &str) -> bool {
    (16..=64).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Starts the MCP server on the given port of this computer (any free one if it is taken) and returns its address.
/// Called again while it runs, it only changes the token.
fn mcp_listen(mcp: &mut Mcp, port: u16, token: String, window: tauri::WebviewWindow) -> Result<String, String> {
    if !token_ok(&token) {
        return Err("invalid token".into());
    }
    *mcp.token.lock().unwrap() = token;
    if mcp.stop.is_some() {
        return Ok(mcp.url.clone());
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).or_else(|_| TcpListener::bind((Ipv4Addr::LOCALHOST, 0))).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    mcp.url = format!("http://127.0.0.1:{}/mcp", listener.local_addr().map_err(|e| e.to_string())?.port());
    mcp.stop = Some(stop.clone());
    let (token, pending, next) = (mcp.token.clone(), mcp.pending.clone(), Arc::new(AtomicU64::new(1)));
    std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            let Ok((stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(40));
                continue;
            };
            let (token, pending, next, window) = (token.clone(), pending.clone(), next.clone(), window.clone());
            std::thread::spawn(move || {
                let token = token.lock().unwrap().clone();
                // The page answers through mcp_reply. While it is still loading it says so itself, so the assistant does not wait in vain.
                mcp_serve(stream, &token, &pending, &next, &|id, hex| {
                    let script = format!(
                        "window.OGE&&OGE.mcp?OGE.mcp.handle({id},'{hex}'):window.__TAURI__.core.invoke('mcp_reply',{{id:{id},body:'{{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{{\"code\":-32002,\"message\":\"OpenGISEarth is still loading\"}}}}'}})"
                    );
                    window.eval(&script).is_ok()
                });
            });
        }
    });
    Ok(mcp.url.clone())
}

#[tauri::command]
fn mcp_start(port: u16, token: String, window: tauri::WebviewWindow, state: tauri::State<'_, Mutex<Mcp>>) -> Result<String, String> {
    mcp_listen(&mut state.lock().unwrap(), port, token, window)
}

/// Stops the MCP server: nothing listens any more.
#[tauri::command]
fn mcp_stop(state: tauri::State<'_, Mutex<Mcp>>) {
    if let Some(stop) = state.lock().unwrap().stop.take() {
        stop.store(true, Ordering::SeqCst);
    }
}

/// The address of the MCP server while it is on.
#[tauri::command]
fn mcp_status(state: tauri::State<'_, Mutex<Mcp>>) -> Option<String> {
    let mcp = state.lock().unwrap();
    mcp.stop.is_some().then(|| mcp.url.clone())
}

/// The page's answer to the request with that number.
#[tauri::command]
fn mcp_reply(id: u64, body: String, state: tauri::State<'_, Mutex<Mcp>>) {
    let waiting = state.lock().unwrap().pending.lock().unwrap().remove(&id);
    if let Some(tx) = waiting {
        let _ = tx.send(body);
    }
}

fn http_reply(stream: &mut TcpStream, status: &str, extra: &str, body: &str) {
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len());
}

/// One HTTP request of an MCP client. Only `POST /mcp` with the right bearer token reaches the page (`forward`, which
/// gets the request's number and its body in hexadecimal); a browser page of another site is turned away by its Origin.
fn mcp_serve(mut stream: TcpStream, token: &str, pending: &Pending, next: &AtomicU64, forward: &dyn Fn(u64, String) -> bool) {
    const MAX_BODY: usize = 4 << 20;
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let (mut buf, mut chunk) = (Vec::new(), [0u8; 4096]);
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        match stream.read(&mut chunk) {
            Ok(n) if n > 0 && buf.len() < 32 << 10 => buf.extend_from_slice(&chunk[..n]),
            _ => return,
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut first = head.split("\r\n").next().unwrap_or("").split(' ');
    let (method, path) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let header = |name: &str| head.split("\r\n").skip(1).find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_string()));
    if path.split('?').next() != Some("/mcp") {
        return http_reply(&mut stream, "404 Not Found", "", "");
    }
    if let Some(origin) = header("origin") {
        if !["http://127.0.0.1", "http://localhost", "http://tauri.localhost", "https://tauri.localhost", "tauri://"].iter().any(|ok| origin.starts_with(ok)) {
            return http_reply(&mut stream, "403 Forbidden", "", "");
        }
    }
    let given = header("authorization").and_then(|v| v.strip_prefix("Bearer ").map(str::to_string)).unwrap_or_default();
    // Compared without stopping at the first difference, so that the time taken says nothing about the token.
    let same = given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0;
    if !same {
        return http_reply(&mut stream, "401 Unauthorized", "WWW-Authenticate: Bearer\r\n", "");
    }
    if method != "POST" {
        return http_reply(&mut stream, "405 Method Not Allowed", "Allow: POST\r\n", "");
    }
    let Some(len) = header("content-length").and_then(|v| v.parse::<usize>().ok()).filter(|n| *n <= MAX_BODY) else {
        return http_reply(&mut stream, "411 Length Required", "", "");
    };
    let mut body = buf[head_end..].to_vec();
    while body.len() < len {
        match stream.read(&mut chunk) {
            Ok(n) if n > 0 => body.extend_from_slice(&chunk[..n]),
            _ => return,
        }
    }
    body.truncate(len);
    let (id, (tx, rx)) = (next.fetch_add(1, Ordering::SeqCst), channel());
    pending.lock().unwrap().insert(id, tx);
    let hex: String = body.iter().map(|b| format!("{b:02x}")).collect();
    // Two minutes: a geoprocessing tool on a large layer takes its time.
    let answer = if forward(id, hex) { rx.recv_timeout(Duration::from_secs(120)).ok() } else { None };
    pending.lock().unwrap().remove(&id);
    match answer {
        Some(body) if body.is_empty() => http_reply(&mut stream, "202 Accepted", "", ""),
        Some(body) => http_reply(&mut stream, "200 OK", "", &body),
        None => http_reply(&mut stream, "504 Gateway Timeout", "", ""),
    }
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
        .manage(Mutex::new(Mcp::default()))
        .setup(|app| {
            // OGE_MCP_TOKEN (and optionally OGE_MCP_PORT) start the MCP server with the program, for whoever launches it from a script.
            if let (Ok(token), Some(window)) = (std::env::var("OGE_MCP_TOKEN"), app.get_webview_window("main")) {
                let port = std::env::var("OGE_MCP_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(47778);
                let _ = mcp_listen(&mut app.state::<Mutex<Mcp>>().lock().unwrap(), port, token, window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![fetch_text, mp_host, mp_find, newer_than_mine, open_release, mcp_start, mcp_stop, mcp_status, mcp_reply])
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

    /// One raw HTTP request to the MCP endpoint and the status line and body that come back.
    fn mcp_ask(port: u16, request: &str) -> String {
        let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        s.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn the_mcp_endpoint_wants_its_token_and_hands_the_body_on() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let pending: Pending = Arc::default();
        std::thread::spawn(move || {
            let next = AtomicU64::new(1);
            for stream in listener.incoming().flatten() {
                let echo = pending.clone();
                // The "page" of the test answers with the hexadecimal it was given: an empty body is a notification.
                mcp_serve(stream, "0123456789abcdef", &pending, &next, &move |id, hex| echo.lock().unwrap().remove(&id).map(|tx| tx.send(hex)).is_some());
            }
        });
        let post = |auth: &str, body: &str| format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth}Content-Length: {}\r\n\r\n{body}", body.len());
        assert!(mcp_ask(port, &post("", "{}")).starts_with("HTTP/1.1 401"));
        assert!(mcp_ask(port, &post("Authorization: Bearer 0123456789abcdeX\r\n", "{}")).starts_with("HTTP/1.1 401"));
        let ok = mcp_ask(port, &post("authorization: Bearer 0123456789abcdef\r\n", "{}"));
        assert!(ok.starts_with("HTTP/1.1 200") && ok.ends_with("7b7d"), "{ok}");
        assert!(mcp_ask(port, &post("Authorization: Bearer 0123456789abcdef\r\n", "")).starts_with("HTTP/1.1 202"));
        assert!(mcp_ask(port, &post("Authorization: Bearer 0123456789abcdef\r\nOrigin: https://example.com\r\n", "{}")).starts_with("HTTP/1.1 403"));
        assert!(mcp_ask(port, "GET /mcp HTTP/1.1\r\nAuthorization: Bearer 0123456789abcdef\r\n\r\n").starts_with("HTTP/1.1 405"));
        assert!(mcp_ask(port, "POST /other HTTP/1.1\r\nContent-Length: 0\r\n\r\n").starts_with("HTTP/1.1 404"));
        assert!(token_ok("0123456789abcdef") && !token_ok("short") && !token_ok("0123456789abcde\"f"));
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
