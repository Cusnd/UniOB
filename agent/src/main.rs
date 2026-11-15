mod collector;
mod config;
mod crypto;
mod migrate;
#[path = "../../shared/network_quality.rs"]
mod network_quality;
mod protocol;
mod sanitize;

use collector::AgentCollector;
use config::Config;
use migrate::{EndpointOverride, MigrationState, CANARY_CTRL_TIMEOUT, DEFAULT_STATE_DIR};
use protocol::{BatchReason, CtrlFrame, MigrateDirective, SampleMode};
use std::io::ErrorKind;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tungstenite::http::Uri;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{client_tls_with_config, ClientRequestBuilder, Connector, Message, WebSocket};

const DEFAULT_CONFIG_PATH: &str = "/etc/uniob/agent.toml";
const PING_INTERVAL: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IO_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const MIN_READ_TIMEOUT: Duration = Duration::from_millis(5);
const MAX_READ_TIMEOUT: Duration = Duration::from_secs(10);
const BACKOFF_SECS: [u64; 6] = [1, 2, 4, 8, 15, 30];

#[derive(Debug, Clone, PartialEq, Eq)]
enum CliAction {
    Run {
        config_path: PathBuf,
        state_dir: PathBuf,
        allow_insecure_ws: bool,
        once: bool,
    },
    Version,
    Help,
}

fn parse_cli_args<I, S>(args: I) -> Result<CliAction, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut config_path = PathBuf::from(DEFAULT_CONFIG_PATH);
    let mut state_dir = PathBuf::from(DEFAULT_STATE_DIR);
    let mut allow_insecure_ws = false;
    let mut once = false;

    let mut iter = args.into_iter();
    let _bin = iter.next();

    while let Some(arg) = iter.next() {
        let s = arg.as_ref();
        match s {
            "-V" | "--version" => return Ok(CliAction::Version),
            "-h" | "--help" => return Ok(CliAction::Help),
            "--once" => once = true,
            "--allow-insecure-ws-for-test" => allow_insecure_ws = true,
            "-c" | "--config" => {
                let val = iter
                    .next()
                    .ok_or_else(|| format!("missing path after {s}"))?;
                let p = val.as_ref();
                if p.is_empty() {
                    return Err("config path must not be empty".to_string());
                }
                config_path = PathBuf::from(p);
            }
            _ if s.starts_with("--config=") => {
                let p = &s["--config=".len()..];
                if p.is_empty() {
                    return Err("config path must not be empty".to_string());
                }
                config_path = PathBuf::from(p);
            }
            "--state-dir" => {
                let val = iter
                    .next()
                    .ok_or_else(|| "missing path after --state-dir".to_string())?;
                let p = val.as_ref();
                if p.is_empty() {
                    return Err("state-dir path must not be empty".to_string());
                }
                state_dir = PathBuf::from(p);
            }
            _ if s.starts_with("--state-dir=") => {
                let p = &s["--state-dir=".len()..];
                if p.is_empty() {
                    return Err("state-dir path must not be empty".to_string());
                }
                state_dir = PathBuf::from(p);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    Ok(CliAction::Run {
        config_path,
        state_dir,
        allow_insecure_ws,
        once,
    })
}

struct XorShift64(u64);

impl XorShift64 {
    fn from_entropy() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9e37_79b9_7f4a_7c15);
        let pid = std::process::id() as u64;
        let mut seed = nanos ^ pid.wrapping_mul(0xbf58_476d_1ce4_e5b9);
        if seed == 0 {
            seed = 0x94d0_49bb_1331_11eb;
        }
        Self(seed)
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn next_signed_unit(&mut self) -> f64 {
        let frac = (self.next_u64() >> 11) as f64 / ((1u64 << 53) as f64);
        frac * 2.0 - 1.0
    }
}

fn compute_backoff(attempt: usize, rng: &mut XorShift64) -> Duration {
    let base_ms = BACKOFF_SECS[attempt.min(BACKOFF_SECS.len() - 1)] * 1000;
    let jitter_factor = 1.0 + rng.next_signed_unit() * 0.20;
    let ms = ((base_ms as f64) * jitter_factor).round().max(100.0) as u64;
    Duration::from_millis(ms)
}

fn build_tls_config() -> Result<Arc<rustls::ClientConfig>, String> {
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("failed to initialize TLS protocol versions: {e}"))?
        .with_root_certificates(root_store)
        .with_no_client_auth();

    Ok(Arc::new(cfg))
}

fn inner_tcp(stream: &MaybeTlsStream<TcpStream>) -> &TcpStream {
    match stream {
        MaybeTlsStream::Plain(tcp) => tcp,
        MaybeTlsStream::Rustls(tls) => &tls.sock,
        _ => unreachable!("only Plain or Rustls streams are opened by connect_ws"),
    }
}

fn connect_ws_to_url(
    target_url: &str,
    cfg: &Config,
    tls_config: &Arc<rustls::ClientConfig>,
    pre_resolved: Option<&[SocketAddr]>,
    enforce_ssrf: bool,
) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, String> {
    let (uri, is_tls, addrs) = if let Some(addrs) = pre_resolved {
        let uri: Uri = target_url
            .parse()
            .map_err(|e| format!("invalid URL '{target_url}': {e}"))?;
        let is_tls = match uri.scheme_str().map(|s| s.to_ascii_lowercase()).as_deref() {
            Some("wss") => true,
            Some("ws") => false,
            other => return Err(format!("unsupported URL scheme: {other:?}")),
        };
        (uri, is_tls, addrs.to_vec())
    } else if enforce_ssrf {
        migrate::validate_and_resolve_ws_url(target_url, false)?
    } else {
        let uri: Uri = target_url
            .parse()
            .map_err(|e| format!("invalid server.url '{target_url}': {e}"))?;
        let is_tls = match uri.scheme_str().map(|s| s.to_ascii_lowercase()).as_deref() {
            Some("wss") => true,
            Some("ws") => false,
            other => return Err(format!("unsupported URL scheme: {other:?}")),
        };
        let raw_host = uri
            .host()
            .ok_or_else(|| "server.url missing host".to_string())?;
        let host = if raw_host.starts_with('[') && raw_host.ends_with(']') {
            &raw_host[1..raw_host.len() - 1]
        } else {
            raw_host
        };
        let port = uri.port_u16().unwrap_or(if is_tls { 443 } else { 80 });
        let addrs: Vec<_> = (host, port)
            .to_socket_addrs()
            .map_err(|e| format!("DNS resolution failed for {host}:{port}: {e}"))?
            .collect();
        if addrs.is_empty() {
            return Err(format!("no addresses resolved for {host}:{port}"));
        }
        (uri, is_tls, addrs)
    };

    let mut tcp = None;
    let mut last_err = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(stream) => {
                tcp = Some(stream);
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let tcp = tcp.ok_or_else(|| {
        format!(
            "TCP connect to {target_url} failed: {}",
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "unknown error".to_string())
        )
    })?;

    tcp.set_nodelay(true)
        .map_err(|e| format!("set_nodelay failed: {e}"))?;
    tcp.set_read_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|e| format!("set_read_timeout failed: {e}"))?;
    tcp.set_write_timeout(Some(IO_WRITE_TIMEOUT))
        .map_err(|e| format!("set_write_timeout failed: {e}"))?;

    let req = ClientRequestBuilder::new(uri)
        .with_header("X-UniOB-Node-Id", &cfg.server.node_id)
        .with_header("Authorization", format!("Bearer {}", cfg.server.token))
        .with_header("X-UniOB-Agent-Version", env!("CARGO_PKG_VERSION"));

    let connector = if is_tls {
        Connector::Rustls(tls_config.clone())
    } else {
        Connector::Plain
    };

    let (ws, _) = client_tls_with_config(req, tcp, None, Some(connector))
        .map_err(|e| format!("WebSocket handshake failed: {e}"))?;

    Ok(ws)
}

#[cfg(test)]
fn connect_ws(
    cfg: &Config,
    tls_config: &Arc<rustls::ClientConfig>,
) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, String> {
    connect_ws_to_url(&cfg.server.url, cfg, tls_config, None, false)
}

fn send_json<T: serde::Serialize>(
    ws: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    frame: &T,
) -> Result<(), String> {
    let payload =
        serde_json::to_string(frame).map_err(|e| format!("JSON serialization error: {e}"))?;
    ws.send(Message::Text(payload))
        .map_err(|e| format!("WebSocket send error: {e}"))
}

/// Piggyback network results on existing m/mb messages. Release only the exact
/// transmitted prefix after a successful send; failures keep the queue intact.
fn send_telemetry<T: serde::Serialize>(
    ws: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    frame: &T,
    quality: &network_quality::ProbeRuntime,
) -> Result<(), String> {
    let extension = quality.payload();
    let mut value = serde_json::to_value(frame).map_err(|e| e.to_string())?;
    if let Some(ref payload) = extension {
        value["network_quality"] = serde_json::to_value(payload).map_err(|e| e.to_string())?;
    }
    send_json(ws, &value)?;
    if let Some(ref payload) = extension {
        quality.mark_sent(payload);
    }
    Ok(())
}

fn perform_canary_handshake(
    directive: &MigrateDirective,
    cfg: &Config,
    tls_config: &Arc<rustls::ClientConfig>,
    collector: &mut AgentCollector,
    mig_state: &MigrationState,
) -> Result<(WebSocket<MaybeTlsStream<TcpStream>>, CtrlFrame), String> {
    let now_sec = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let (_uri, _is_tls, addrs) = migrate::verify_migrate_directive(
        directive,
        &cfg.server.node_id,
        &cfg.server.token,
        now_sec,
        mig_state.last_applied_epoch,
        mig_state.allow_insecure_ws,
    )?;

    let mut canary_ws = connect_ws_to_url(
        &directive.url,
        cfg,
        tls_config,
        Some(&addrs),
        !mig_state.allow_insecure_ws,
    )?;

    let hello = collector.collect_hello_with_epoch(Some(directive.epoch));
    send_json(&mut canary_ws, &hello)?;

    let deadline = Instant::now() + CANARY_CTRL_TIMEOUT;
    loop {
        let now = Instant::now();
        if now >= deadline {
            let _ = canary_ws.close(None);
            return Err("canary handshake timed out waiting for ctrl".to_string());
        }

        let wait = deadline
            .saturating_duration_since(now)
            .clamp(MIN_READ_TIMEOUT, MAX_READ_TIMEOUT);
        inner_tcp(canary_ws.get_ref())
            .set_read_timeout(Some(wait))
            .map_err(|e| format!("canary set_read_timeout failed: {e}"))?;

        match canary_ws.read() {
            Ok(Message::Text(txt)) => match CtrlFrame::parse(&txt) {
                Ok(ctrl) => return Ok((canary_ws, ctrl)),
                Err(e) => {
                    eprintln!("canary ignoring non-ctrl text frame: {e}");
                }
            },
            Ok(Message::Ping(_)) => {
                canary_ws
                    .flush()
                    .map_err(|e| format!("canary pong flush error: {e}"))?;
            }
            Ok(Message::Pong(_)) | Ok(Message::Binary(_)) | Ok(Message::Frame(_)) => {}
            Ok(Message::Close(_)) => {
                return Err("canary server closed WebSocket before sending ctrl".to_string());
            }
            Err(tungstenite::Error::Io(ref e))
                if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(tungstenite::Error::ConnectionClosed) => {
                return Err("canary WebSocket connection closed before ctrl".to_string());
            }
            Err(e) => return Err(format!("canary WebSocket read error: {e}")),
        }
    }
}

struct MigrationRuntime<'a> {
    cfg: &'a Config,
    tls_config: &'a Arc<rustls::ClientConfig>,
    state: &'a mut MigrationState,
    session_started_at: &'a mut Instant,
}

fn run_session_with_migration(
    ws: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    collector: &mut AgentCollector,
    mut mig_rt: Option<MigrationRuntime<'_>>,
) -> Result<(), String> {
    collector.network_first_ctrl = true;
    let hello = collector.collect_hello();
    send_json(ws, &hello)?;

    collector.warm_baseline();
    let start = Instant::now();
    let mut initial_snapshot_pending = true;
    let mut next_sample_at = start + Duration::from_millis(200);
    let mut next_ping_at = start + PING_INTERVAL;
    let mut next_cohort_at = collector.next_cohort_instant(start, SystemTime::now());

    loop {
        let now = Instant::now();

        if collector.check_lease(now) {
            next_sample_at = next_sample_at.min(now + collector.scheduler.interval);
            next_cohort_at = collector.next_cohort_instant(now, SystemTime::now());
        }

        if now >= next_ping_at {
            ws.send(Message::Ping(Vec::new()))
                .map_err(|e| format!("WebSocket ping error: {e}"))?;
            next_ping_at = now + PING_INTERVAL;
        }

        if now >= next_sample_at {
            if initial_snapshot_pending {
                initial_snapshot_pending = false;
                if collector.scheduler.mode == SampleMode::Idle {
                    let batch = collector.collect_hello_batch(now);
                    send_telemetry(ws, &batch, &collector.network_quality)?;
                } else {
                    let metrics = collector.collect_metrics_and_seed_edge(now);
                    send_telemetry(ws, &metrics, &collector.network_quality)?;
                }
            } else if collector.scheduler.mode == SampleMode::Idle {
                if let Some(edge_batch) = collector.collect_idle_tick(now) {
                    send_telemetry(ws, &edge_batch, &collector.network_quality)?;
                }
            } else {
                let metrics = collector.collect_metrics_and_seed_edge(now);
                send_telemetry(ws, &metrics, &collector.network_quality)?;
            }
            next_sample_at = now + collector.scheduler.interval;
        }

        if collector.scheduler.mode == SampleMode::Idle
            && !initial_snapshot_pending
            && now >= next_cohort_at
        {
            if let Some(cohort_batch) = collector.take_batch(BatchReason::Cohort) {
                send_telemetry(ws, &cohort_batch, &collector.network_quality)?;
            }
            collector.mark_cohort_fired();
            next_cohort_at = collector.next_cohort_instant(now, SystemTime::now());
        }

        let now_after_send = Instant::now();
        let mut earliest = next_sample_at.min(next_ping_at);
        if collector.scheduler.mode == SampleMode::Idle && !initial_snapshot_pending {
            earliest = earliest.min(next_cohort_at);
        }
        if let Some(lease_exp) = collector.scheduler.lease_expires_at {
            earliest = earliest.min(lease_exp);
        }
        let wait = earliest
            .saturating_duration_since(now_after_send)
            .clamp(MIN_READ_TIMEOUT, MAX_READ_TIMEOUT);

        inner_tcp(ws.get_ref())
            .set_read_timeout(Some(wait))
            .map_err(|e| format!("set_read_timeout failed: {e}"))?;

        match ws.read() {
            Ok(Message::Text(txt)) => match CtrlFrame::parse(&txt) {
                Ok(mut ctrl) => {
                    let migrate_opt = ctrl.migrate.take();
                    let flush_now = ctrl.flush_now == Some(true);
                    let prev_mode = collector.scheduler.mode;
                    let apply_now = Instant::now();
                    collector.apply_ctrl(ctrl, apply_now);
                    let new_mode = collector.scheduler.mode;

                    if flush_now {
                        let batch = collector.collect_flush_batch(apply_now);
                        send_telemetry(ws, &batch, &collector.network_quality)?;
                    } else if prev_mode == SampleMode::Idle && new_mode != SampleMode::Idle {
                        if let Some(batch) = collector.take_batch(BatchReason::Flush) {
                            send_telemetry(ws, &batch, &collector.network_quality)?;
                        }
                    }

                    if new_mode != SampleMode::Idle && prev_mode != new_mode {
                        initial_snapshot_pending = false;
                        next_sample_at = apply_now;
                    } else if new_mode == SampleMode::Idle && prev_mode != SampleMode::Idle {
                        next_cohort_at =
                            collector.next_cohort_instant(apply_now, SystemTime::now());
                        next_sample_at =
                            next_sample_at.min(apply_now + collector.scheduler.interval);
                    } else {
                        next_sample_at =
                            next_sample_at.min(apply_now + collector.scheduler.interval);
                    }

                    if let Some(directive) = migrate_opt {
                        if let Some(ref mut rt) = mig_rt {
                            match perform_canary_handshake(
                                &directive,
                                rt.cfg,
                                rt.tls_config,
                                collector,
                                rt.state,
                            ) {
                                Ok((canary_ws, mut canary_ctrl)) => {
                                    let ovr = EndpointOverride {
                                        url: directive.url.clone(),
                                        fallback_url: directive.fallback_url.clone(),
                                        epoch: directive.epoch,
                                    };
                                    if let Err(e) = rt.state.commit_override(ovr) {
                                        eprintln!(
                                            "warning: could not persist endpoint_override.toml (using in-memory override): {e}"
                                        );
                                    }
                                    collector.set_migrated_epoch(Some(directive.epoch));

                                    let _ = ws.close(None);
                                    let _ = ws.flush();
                                    *ws = canary_ws;
                                    *rt.session_started_at = Instant::now();

                                    collector.reset_session_buffers_for_cutover();
                                    collector.warm_baseline();
                                    let cutover_now = Instant::now();
                                    next_ping_at = cutover_now + PING_INTERVAL;

                                    canary_ctrl.migrate = None;
                                    collector.network_first_ctrl = true;
                                    let canary_flush = canary_ctrl.flush_now == Some(true);
                                    collector.apply_ctrl(canary_ctrl, cutover_now);
                                    if canary_flush {
                                        let batch = collector.collect_flush_batch(cutover_now);
                                        send_telemetry(ws, &batch, &collector.network_quality)?;
                                    }

                                    if collector.scheduler.mode != SampleMode::Idle {
                                        initial_snapshot_pending = false;
                                        next_sample_at = cutover_now;
                                    } else {
                                        initial_snapshot_pending = true;
                                        next_sample_at = cutover_now + Duration::from_millis(200);
                                        next_cohort_at = collector
                                            .next_cohort_instant(cutover_now, SystemTime::now());
                                    }
                                }
                                Err(err) => {
                                    eprintln!("canary migration rejected/failed: {err}");
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("ignoring invalid ctrl frame: {e}");
                }
            },
            Ok(Message::Ping(_)) => {
                ws.flush()
                    .map_err(|e| format!("WebSocket pong flush error: {e}"))?;
            }
            Ok(Message::Pong(_)) | Ok(Message::Binary(_)) | Ok(Message::Frame(_)) => {}
            Ok(Message::Close(_)) => return Err("server closed WebSocket connection".to_string()),
            Err(tungstenite::Error::Io(ref e))
                if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(tungstenite::Error::ConnectionClosed) => {
                return Err("WebSocket connection closed".to_string());
            }
            Err(e) => return Err(format!("WebSocket read error: {e}")),
        }
    }
}

#[cfg(test)]
fn run_session(
    ws: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    collector: &mut AgentCollector,
) -> Result<(), String> {
    run_session_with_migration(ws, collector, None)
}

fn run_once(cfg: Config) -> Result<(), String> {
    let mut collector = AgentCollector::new(cfg);
    let hello = collector.collect_hello();
    collector.warm_baseline();
    std::thread::sleep(Duration::from_millis(200));
    let metrics = collector.collect_metrics(Instant::now());

    let snapshot = serde_json::json!({
        "hello": hello,
        "metrics": metrics,
    });
    let out = serde_json::to_string_pretty(&snapshot)
        .map_err(|e| format!("failed to serialize snapshot: {e}"))?;
    println!("{out}");
    Ok(())
}

fn run_daemon(cfg: Config, state_dir: PathBuf, allow_insecure_ws: bool) -> Result<(), String> {
    let tls_config = build_tls_config()?;
    let mut mig_state = MigrationState::init(state_dir, allow_insecure_ws);
    let mut collector = AgentCollector::new(cfg.clone());
    let mut rng = XorShift64::from_entropy();
    let mut attempt: usize = 0;

    loop {
        let using_override = mig_state.is_using_override();
        let enforce_ssrf = using_override && !mig_state.allow_insecure_ws;
        let target_url = mig_state.current_url(&cfg.server.url).to_string();
        collector.set_migrated_epoch(mig_state.current_migrated_epoch());

        match connect_ws_to_url(&target_url, &cfg, &tls_config, None, enforce_ssrf) {
            Ok(mut ws) => {
                let mut session_started_at = Instant::now();
                let res = run_session_with_migration(
                    &mut ws,
                    &mut collector,
                    Some(MigrationRuntime {
                        cfg: &cfg,
                        tls_config: &tls_config,
                        state: &mut mig_state,
                        session_started_at: &mut session_started_at,
                    }),
                );
                if let Err(err) = res {
                    eprintln!("session ended: {err}");
                }

                if session_started_at.elapsed() >= Duration::from_secs(10) {
                    attempt = 0;
                    mig_state.record_override_success();
                } else if mig_state.is_using_override()
                    && mig_state.record_override_failure(Instant::now())
                {
                    eprintln!(
                        "override endpoint failed repeatedly; reverting to bootstrap server.url"
                    );
                    attempt = 0;
                    collector.set_migrated_epoch(None);
                }
                collector.reset_on_disconnect();
            }
            Err(err) => {
                eprintln!("connect error ({target_url}): {err}");
                if mig_state.is_using_override()
                    && mig_state.record_override_failure(Instant::now())
                {
                    eprintln!("override endpoint unreachable; reverting to bootstrap server.url");
                    attempt = 0;
                    collector.set_migrated_epoch(None);
                    continue;
                }
            }
        }

        let delay = compute_backoff(attempt, &mut rng);
        attempt = attempt.saturating_add(1);
        eprintln!("reconnecting in {} ms...", delay.as_millis());
        std::thread::sleep(delay);
    }
}

fn print_help() {
    println!(
        "{} {}\n\nUSAGE:\n    uniob-agent [OPTIONS]\n\nOPTIONS:\n    -c, --config <PATH>            Path to TOML config (default: {DEFAULT_CONFIG_PATH})\n    --state-dir <PATH>             Directory for runtime override state (default: {DEFAULT_STATE_DIR})\n    --allow-insecure-ws-for-test   Allow ws:// and private IPs for local testing\n    --once                         Print one hello + metrics JSON snapshot and exit\n    -V, --version                  Print version and exit\n    -h, --help                     Print help and exit",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION")
    );
}

fn main() {
    let action = match parse_cli_args(std::env::args()) {
        Ok(action) => action,
        Err(err) => {
            eprintln!("error: {err}");
            std::process::exit(2);
        }
    };

    match action {
        CliAction::Version => {
            println!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
        }
        CliAction::Help => {
            print_help();
        }
        CliAction::Run {
            config_path,
            state_dir,
            allow_insecure_ws,
            once,
        } => {
            let cfg = match Config::load(&config_path) {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("error: {err}");
                    std::process::exit(1);
                }
            };

            let res = if once {
                run_once(cfg)
            } else {
                run_daemon(cfg, state_dir, allow_insecure_ws)
            };
            if let Err(err) = res {
                eprintln!("fatal: {err}");
                std::process::exit(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use tungstenite::handshake::server::{Request as HsRequest, Response as HsResponse};

    #[allow(clippy::result_large_err)]
    fn accept_one_ws(listener: &TcpListener) -> (WebSocket<TcpStream>, Vec<(String, String)>) {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut captured_headers = Vec::new();
        let ws = tungstenite::accept_hdr(stream, |req: &HsRequest, resp: HsResponse| {
            for name in ["x-uniob-node-id", "authorization", "x-uniob-agent-version"] {
                let val = req
                    .headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                captured_headers.push((name.to_string(), val));
            }
            Ok(resp)
        })
        .unwrap();
        (ws, captured_headers)
    }

    fn read_json_frame(ws: &mut WebSocket<TcpStream>) -> serde_json::Value {
        loop {
            match ws.read().unwrap() {
                Message::Text(t) => return serde_json::from_str(&t).unwrap(),
                Message::Ping(_) => {
                    let _ = ws.flush();
                }
                other => panic!("expected text frame, got {other:?}"),
            }
        }
    }

    fn unique_state_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "uniob_main_test_{label}_{}_{}",
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cli_args_parse_defaults_once_and_version() {
        assert_eq!(
            parse_cli_args(["uniob-agent"]).unwrap(),
            CliAction::Run {
                config_path: PathBuf::from(DEFAULT_CONFIG_PATH),
                state_dir: PathBuf::from(DEFAULT_STATE_DIR),
                allow_insecure_ws: false,
                once: false,
            }
        );

        assert_eq!(
            parse_cli_args(["uniob-agent", "--config", "/tmp/a.toml", "--once"]).unwrap(),
            CliAction::Run {
                config_path: PathBuf::from("/tmp/a.toml"),
                state_dir: PathBuf::from(DEFAULT_STATE_DIR),
                allow_insecure_ws: false,
                once: true,
            }
        );

        assert_eq!(
            parse_cli_args([
                "uniob-agent",
                "-c",
                "/etc/c.toml",
                "--state-dir",
                "/tmp/state",
                "--allow-insecure-ws-for-test",
            ])
            .unwrap(),
            CliAction::Run {
                config_path: PathBuf::from("/etc/c.toml"),
                state_dir: PathBuf::from("/tmp/state"),
                allow_insecure_ws: true,
                once: false,
            }
        );

        assert_eq!(
            parse_cli_args([
                "uniob-agent",
                "--config=/etc/custom.toml",
                "--state-dir=/var/lib/custom",
            ])
            .unwrap(),
            CliAction::Run {
                config_path: PathBuf::from("/etc/custom.toml"),
                state_dir: PathBuf::from("/var/lib/custom"),
                allow_insecure_ws: false,
                once: false,
            }
        );

        assert_eq!(
            parse_cli_args(["uniob-agent", "--version"]).unwrap(),
            CliAction::Version
        );
        assert_eq!(
            parse_cli_args(["uniob-agent", "-V"]).unwrap(),
            CliAction::Version
        );
        assert_eq!(
            parse_cli_args(["uniob-agent", "-h"]).unwrap(),
            CliAction::Help
        );

        assert!(parse_cli_args(["uniob-agent", "--config"]).is_err());
        assert!(parse_cli_args(["uniob-agent", "--state-dir"]).is_err());
        assert!(parse_cli_args(["uniob-agent", "--state-dir="]).is_err());
        assert!(parse_cli_args(["uniob-agent", "--unknown"]).is_err());
    }

    #[test]
    fn reconnect_backoff_schedule_stays_within_20_percent_jitter() {
        let mut rng = XorShift64(0x1234_5678_9abc_def0);
        let expected_bases = [1000u128, 2000, 4000, 8000, 15000, 30000, 30000];
        for (attempt, &base) in expected_bases.iter().enumerate() {
            for _ in 0..50 {
                let d = compute_backoff(attempt, &mut rng).as_millis();
                let min_ms = (base * 80) / 100;
                let max_ms = (base * 120) / 100;
                assert!(
                    d >= min_ms && d <= max_ms,
                    "attempt {attempt}: {d}ms out of [{min_ms}, {max_ms}]"
                );
            }
        }
    }

    #[test]
    fn websocket_loopback_handshake_sends_headers_hello_ctrl_and_metrics() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server_thread = std::thread::spawn(move || {
            let (mut ws, captured_headers) = accept_one_ws(&listener);

            assert_eq!(
                captured_headers,
                vec![
                    ("x-uniob-node-id".to_string(), "nd_loop".to_string()),
                    (
                        "authorization".to_string(),
                        "Bearer uob_live_testtok".to_string()
                    ),
                    (
                        "x-uniob-agent-version".to_string(),
                        env!("CARGO_PKG_VERSION").to_string()
                    ),
                ]
            );

            // 1. Expect HelloFrame v2
            let hello_val = read_json_frame(&mut ws);
            assert_eq!(hello_val["t"], "hello");
            assert_eq!(hello_val["v"], 2);
            assert_eq!(
                hello_val["capabilities"],
                serde_json::json!(["mb_v2", "migrate_v1", "network_quality_v1"])
            );

            // 2. Send CtrlFrame switching to Live (mode 1) within 200ms
            ws.send(Message::Text(
                r#"{"t":"ctrl","mode":1,"interval_ms":1000,"top_n":10,"lease_sec":30}"#.to_string(),
            ))
            .unwrap();

            // 3. Expect MetricsFrame directly
            let metrics_val = read_json_frame(&mut ws);
            assert_eq!(metrics_val["t"], "m");
            assert!(metrics_val.get("procs").is_none());

            let _ = ws.close(None);
        });

        let cfg = Config::from_toml_str(&format!(
            r#"
[server]
url = "ws://{addr}"
node_id = "nd_loop"
token = "uob_live_testtok"
"#
        ))
        .unwrap();

        let tls_cfg = build_tls_config().unwrap();
        let mut ws = connect_ws(&cfg, &tls_cfg).unwrap();
        let mut collector = AgentCollector::new(cfg);

        // Server closes after receiving hello + metrics -> run_session returns Err cleanly.
        let session_res = run_session(&mut ws, &mut collector);
        assert!(session_res.is_err());
        assert_eq!(collector.scheduler.mode, SampleMode::Live);
        server_thread.join().unwrap();
    }

    #[test]
    fn websocket_network_extension_piggybacks_batch_and_live_with_error_isolation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let control = network_quality::make_control(&network_quality::default_config());
        let expected_id = control.config_id.clone();
        let server = std::thread::spawn(move || {
            let (mut ws, _) = accept_one_ws(&listener);
            let hello = read_json_frame(&mut ws);
            assert!(hello["capabilities"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("network_quality_v1")));
            ws.send(Message::Text(serde_json::json!({"t":"ctrl","mode":0,"interval_ms":30000,"flush_now":true,"network_quality":control}).to_string())).unwrap();
            let batch = read_json_frame(&mut ws);
            assert_eq!(batch["t"], "mb");
            assert_eq!(batch["pts"][0].as_array().unwrap().len(), 16);
            assert!(batch["last"].get("network_quality").is_none());
            assert_eq!(batch["network_quality"]["enabled"], false);
            assert_eq!(batch["network_quality"]["applied_config_id"], expected_id);
            ws.send(Message::Text(serde_json::json!({"t":"ctrl","mode":1,"interval_ms":1000,"lease_sec":30,"network_quality":{"schema_version":99}}).to_string())).unwrap();
            let live = loop {
                let f = read_json_frame(&mut ws);
                if f["t"] == "m" {
                    break f;
                }
            };
            assert!(live["cpu"].is_object());
            assert_eq!(live["network_quality"]["enabled"], false);
            assert!(live["network_quality"]["config_error"].is_string());
            let _ = ws.close(None);
        });
        let cfg = Config::from_toml_str(&format!(
            "[server]\nurl='ws://{addr}'\nnode_id='network-loop'\ntoken='token'\n"
        ))
        .unwrap();
        let tls = build_tls_config().unwrap();
        let mut ws = connect_ws(&cfg, &tls).unwrap();
        let mut collector = AgentCollector::new(cfg);
        assert!(run_session(&mut ws, &mut collector).is_err());
        assert_eq!(collector.scheduler.mode, SampleMode::Live);
        server.join().unwrap();
    }

    #[test]
    fn canary_network_control_is_only_applied_after_cutover() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let cfg = Config::from_toml_str(
            "[server]\nurl='ws://127.0.0.1:1'\nnode_id='canary-quality'\ntoken='canary-token'\n",
        )
        .unwrap();
        let tls = build_tls_config().unwrap();
        let mut collector = AgentCollector::new(cfg.clone());
        let old = network_quality::make_control(&network_quality::default_config());
        collector.apply_ctrl(
            CtrlFrame {
                network_quality: Some(serde_json::to_value(&old).unwrap()),
                ..Default::default()
            },
            Instant::now(),
        );
        let mut config = network_quality::default_config();
        config.targets[0].label = "candidate".into();
        let candidate = network_quality::make_control(&config);
        let expected_candidate = candidate.config_id.clone();
        let server = std::thread::spawn(move || {
            let (mut ws, _) = accept_one_ws(&listener);
            let _ = read_json_frame(&mut ws);
            ws.send(Message::Text(
                serde_json::json!({"t":"ctrl","mode":0,"network_quality":candidate}).to_string(),
            ))
            .unwrap();
        });
        let state_dir = unique_state_dir("quality_canary");
        let state = MigrationState::init(state_dir.clone(), true);
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let url = format!("ws://{addr}");
        let directive = MigrateDirective {
            sig: migrate::compute_migrate_hmac_hex(
                &cfg.server.token,
                &cfg.server.node_id,
                epoch,
                &url,
            ),
            url,
            fallback_url: None,
            epoch,
        };
        let (_, candidate_ctrl) =
            perform_canary_handshake(&directive, &cfg, &tls, &mut collector, &state).unwrap();
        assert_eq!(
            collector
                .network_quality
                .payload()
                .unwrap()
                .applied_config_id,
            Some(old.config_id)
        );
        collector.network_first_ctrl = true;
        collector.apply_ctrl(candidate_ctrl, Instant::now());
        assert_eq!(
            collector
                .network_quality
                .payload()
                .unwrap()
                .applied_config_id,
            Some(expected_candidate)
        );
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(state_dir);
    }

    #[test]
    fn websocket_loopback_idle_sends_hello_mb_flush_now_and_transition_0_to_1_flush() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server_thread = std::thread::spawn(move || {
            let (mut ws, _) = accept_one_ws(&listener);

            let hello = read_json_frame(&mut ws);
            assert_eq!(hello["t"], "hello");
            assert_eq!(hello["v"], 2);

            // Keep in mode 0 with 1s idle sampling interval so ring accumulates a sample
            ws.send(Message::Text(
                r#"{"t":"ctrl","mode":0,"interval_ms":1000,"batch_sec":300,"top_n":0,"lease_sec":0}"#
                    .to_string(),
            ))
            .unwrap();

            // Expect initial 200ms hello mb snapshot
            let mb_hello = read_json_frame(&mut ws);
            assert_eq!(mb_hello["t"], "mb");
            assert_eq!(mb_hello["v"], 2);
            assert_eq!(mb_hello["reason"], "hello");
            assert_eq!(mb_hello["pts"].as_array().unwrap().len(), 1);
            assert_eq!(mb_hello["pts"][0].as_array().unwrap().len(), 16);
            assert!(mb_hello["last"].get("t").is_none());

            // Wait 1.2s so 1 idle tick buffers into the ring buffer, then trigger flush_now
            std::thread::sleep(Duration::from_millis(1200));
            ws.send(Message::Text(
                r#"{"t":"ctrl","mode":0,"interval_ms":1000,"batch_sec":300,"top_n":0,"lease_sec":0,"flush_now":true}"#
                    .to_string(),
            ))
            .unwrap();

            let mb_flush = read_json_frame(&mut ws);
            assert_eq!(mb_flush["t"], "mb");
            assert_eq!(mb_flush["reason"], "flush");
            assert!(!mb_flush["pts"].as_array().unwrap().is_empty());

            // Wait another 1.2s so another sample buffers, then switch 0 -> 1
            std::thread::sleep(Duration::from_millis(1200));
            ws.send(Message::Text(
                r#"{"t":"ctrl","mode":1,"interval_ms":1000,"top_n":10,"lease_sec":30}"#.to_string(),
            ))
            .unwrap();

            let mb_trans = read_json_frame(&mut ws);
            assert_eq!(mb_trans["t"], "mb");
            assert_eq!(mb_trans["reason"], "flush");

            let live_m = read_json_frame(&mut ws);
            assert_eq!(live_m["t"], "m");

            let _ = ws.close(None);
        });

        let cfg = Config::from_toml_str(&format!(
            r#"
[server]
url = "ws://{addr}"
node_id = "nd_v2_loop"
token = "uob_live_testtok"
"#
        ))
        .unwrap();

        let tls_cfg = build_tls_config().unwrap();
        let mut ws = connect_ws(&cfg, &tls_cfg).unwrap();
        let mut collector = AgentCollector::new(cfg);
        let res = run_session(&mut ws, &mut collector);
        assert!(res.is_err());
        server_thread.join().unwrap();
    }

    #[test]
    fn websocket_loopback_canary_migration_persists_override_and_switches_session() {
        let state_dir = unique_state_dir("canary_ok");
        let hub1 = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr1 = hub1.local_addr().unwrap();
        let hub2 = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr2 = hub2.local_addr().unwrap();

        let token = "uob_live_canary_tok";
        let node_id = "nd_canary";
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let target_url = format!("ws://{addr2}/api/agent/ws");
        let sig = migrate::compute_migrate_hmac_hex(token, node_id, epoch, &target_url);

        let target_url_srv = target_url.clone();
        let replay_url = format!("ws://{addr1}/api/agent/ws");
        let replay_sig = migrate::compute_migrate_hmac_hex(token, node_id, epoch, &replay_url);
        let h1_thread = std::thread::spawn(move || {
            let (mut ws1, _) = accept_one_ws(&hub1);
            let hello1 = read_json_frame(&mut ws1);
            assert_eq!(hello1["t"], "hello");
            assert!(hello1.get("migrated_epoch").is_none());

            let ctrl_msg = serde_json::json!({
                "t": "ctrl",
                "mode": 0,
                "interval_ms": 30000,
                "batch_sec": 300,
                "top_n": 0,
                "lease_sec": 0,
                "migrate": {
                    "url": target_url_srv,
                    "fallback_url": format!("ws://{addr1}/api/agent/ws"),
                    "epoch": epoch,
                    "sig": sig
                }
            });
            ws1.send(Message::Text(ctrl_msg.to_string())).unwrap();

            // Expect old WS to close cleanly after canary succeeds
            loop {
                match ws1.read() {
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });

        let h2_thread = std::thread::spawn(move || {
            let (mut ws2, _) = accept_one_ws(&hub2);
            let hello2 = read_json_frame(&mut ws2);
            assert_eq!(hello2["t"], "hello");
            assert_eq!(hello2["v"], 2);
            assert_eq!(hello2["migrated_epoch"], epoch);

            // Canary sends ctrl mode 1 -> agent immediately streams m on canary WS
            ws2.send(Message::Text(
                r#"{"t":"ctrl","mode":1,"interval_ms":1000,"top_n":10,"lease_sec":30}"#.to_string(),
            ))
            .unwrap();

            let m2 = read_json_frame(&mut ws2);
            assert_eq!(m2["t"], "m");

            // Sending a replay migrate with the same epoch must be rejected, keeping Hub2 alive
            ws2.send(Message::Text(
                serde_json::json!({
                    "t": "ctrl",
                    "mode": 1,
                    "interval_ms": 1000,
                    "top_n": 10,
                    "lease_sec": 30,
                    "migrate": { "url": replay_url, "epoch": epoch, "sig": replay_sig }
                })
                .to_string(),
            ))
            .unwrap();

            let m2_after_replay = read_json_frame(&mut ws2);
            assert_eq!(m2_after_replay["t"], "m");
            let _ = ws2.close(None);
        });

        let cfg = Config::from_toml_str(&format!(
            r#"
[server]
url = "ws://{addr1}/api/agent/ws"
node_id = "{node_id}"
token = "{token}"
"#
        ))
        .unwrap();

        let tls_cfg = build_tls_config().unwrap();
        let mut ws = connect_ws(&cfg, &tls_cfg).unwrap();
        let mut collector = AgentCollector::new(cfg.clone());
        let mut mig_state = MigrationState::init(state_dir.clone(), true);
        let mut session_started_at = Instant::now();

        let _ = run_session_with_migration(
            &mut ws,
            &mut collector,
            Some(MigrationRuntime {
                cfg: &cfg,
                tls_config: &tls_cfg,
                state: &mut mig_state,
                session_started_at: &mut session_started_at,
            }),
        );

        h1_thread.join().unwrap();
        h2_thread.join().unwrap();

        assert_eq!(mig_state.last_applied_epoch, epoch);
        assert_eq!(
            mig_state.active_override.as_ref().map(|o| o.url.as_str()),
            Some(target_url.as_str())
        );
        let persisted = migrate::load_override(&state_dir, true).unwrap();
        assert_eq!(persisted.url, target_url);
        assert_eq!(persisted.epoch, epoch);

        let _ = std::fs::remove_dir_all(&state_dir);
    }

    #[test]
    fn websocket_loopback_canary_readonly_state_dir_and_failure_keeps_old_ws() {
        let base_dir = unique_state_dir("canary_ro_fail");
        let ro_blocker = base_dir.join("readonly_state_dir");
        std::fs::write(&ro_blocker, b"not-a-dir").unwrap();

        let hub1 = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr1 = hub1.local_addr().unwrap();
        let hub2 = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr2 = hub2.local_addr().unwrap();

        let hub_close = TcpListener::bind("127.0.0.1:0").unwrap();
        let close_addr = hub_close.local_addr().unwrap();

        let token = "uob_live_ro_tok";
        let node_id = "nd_ro";
        let now_epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let bad_url = format!("ws://{close_addr}/api/agent/ws");
        let bad_target_sig = migrate::compute_migrate_hmac_hex(token, node_id, now_epoch, &bad_url);
        let good_url = format!("ws://{addr2}/api/agent/ws");
        let expired_sig =
            migrate::compute_migrate_hmac_hex(token, node_id, now_epoch - 700, &good_url);
        let invalid_hmac_sig = "f".repeat(64);
        let good_sig = migrate::compute_migrate_hmac_hex(token, node_id, now_epoch + 1, &good_url);

        let close_thread = std::thread::spawn(move || {
            let (mut ws_bad, _) = accept_one_ws(&hub_close);
            let _hello = read_json_frame(&mut ws_bad);
            // Close before sending ctrl -> canary handshake fails!
            let _ = ws_bad.close(None);
        });

        let h1_thread = std::thread::spawn(move || {
            let (mut ws1, _) = accept_one_ws(&hub1);
            let _hello1 = read_json_frame(&mut ws1);

            // 1. Bad HMAC -> rejected, old WS stays alive
            ws1.send(Message::Text(
                serde_json::json!({
                    "t": "ctrl",
                    "mode": 0,
                    "interval_ms": 30000,
                    "top_n": 0,
                    "lease_sec": 0,
                    "migrate": { "url": good_url, "epoch": now_epoch, "sig": invalid_hmac_sig }
                })
                .to_string(),
            ))
            .unwrap();

            // 2. Expired epoch (> 600s skew) -> rejected, old WS stays alive
            ws1.send(Message::Text(
                serde_json::json!({
                    "t": "ctrl",
                    "mode": 0,
                    "interval_ms": 30000,
                    "top_n": 0,
                    "lease_sec": 0,
                    "migrate": { "url": good_url, "epoch": now_epoch - 700, "sig": expired_sig }
                })
                .to_string(),
            ))
            .unwrap();

            // 3. Canary server closes without sending ctrl -> canary fails, old WS stays alive!
            ws1.send(Message::Text(
                serde_json::json!({
                    "t": "ctrl",
                    "mode": 0,
                    "interval_ms": 30000,
                    "top_n": 0,
                    "lease_sec": 0,
                    "migrate": { "url": bad_url, "epoch": now_epoch, "sig": bad_target_sig }
                })
                .to_string(),
            ))
            .unwrap();

            // Verify old WS still answers flush_now after rejected migrations
            ws1.send(Message::Text(
                r#"{"t":"ctrl","mode":0,"interval_ms":30000,"top_n":0,"lease_sec":0,"flush_now":true}"#
                    .to_string(),
            ))
            .unwrap();
            let mb = loop {
                let frame = read_json_frame(&mut ws1);
                if frame["t"] == "mb" && frame["reason"] == "flush" {
                    break frame;
                }
            };
            assert_eq!(mb["t"], "mb");
            assert_eq!(mb["reason"], "flush");

            // 4. Valid canary -> switches even though state_dir is read-only!
            ws1.send(Message::Text(
                serde_json::json!({
                    "t": "ctrl",
                    "mode": 0,
                    "interval_ms": 30000,
                    "top_n": 0,
                    "lease_sec": 0,
                    "migrate": { "url": good_url, "epoch": now_epoch + 1, "sig": good_sig }
                })
                .to_string(),
            ))
            .unwrap();

            loop {
                match ws1.read() {
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });

        let h2_thread = std::thread::spawn(move || {
            let (mut ws2, _) = accept_one_ws(&hub2);
            let hello2 = read_json_frame(&mut ws2);
            assert_eq!(hello2["migrated_epoch"], now_epoch + 1);
            ws2.send(Message::Text(
                r#"{"t":"ctrl","mode":1,"interval_ms":1000,"top_n":10,"lease_sec":30}"#.to_string(),
            ))
            .unwrap();
            let m2 = read_json_frame(&mut ws2);
            assert_eq!(m2["t"], "m");
            let _ = ws2.close(None);
        });

        let cfg = Config::from_toml_str(&format!(
            r#"
[server]
url = "ws://{addr1}/api/agent/ws"
node_id = "{node_id}"
token = "{token}"
"#
        ))
        .unwrap();

        let tls_cfg = build_tls_config().unwrap();
        let mut ws = connect_ws(&cfg, &tls_cfg).unwrap();
        let mut collector = AgentCollector::new(cfg.clone());
        let mut mig_state = MigrationState::init(ro_blocker, true);
        let mut session_started_at = Instant::now();

        let _ = run_session_with_migration(
            &mut ws,
            &mut collector,
            Some(MigrationRuntime {
                cfg: &cfg,
                tls_config: &tls_cfg,
                state: &mut mig_state,
                session_started_at: &mut session_started_at,
            }),
        );

        h1_thread.join().unwrap();
        close_thread.join().unwrap();
        h2_thread.join().unwrap();

        assert_eq!(mig_state.last_applied_epoch, now_epoch + 1);
        assert!(mig_state.active_override.is_some());

        let _ = std::fs::remove_dir_all(&base_dir);
    }

    #[test]
    fn canary_handshake_enforces_ssrf_when_allow_insecure_ws_is_false() {
        let state_dir = unique_state_dir("canary_ssrf");
        let cfg = Config::from_toml_str(
            r#"
[server]
url = "wss://boot.example.com/api/agent/ws"
node_id = "nd_ssrf"
token = "tok_ssrf"
"#,
        )
        .unwrap();
        let tls_cfg = build_tls_config().unwrap();
        let mut collector = AgentCollector::new(cfg.clone());
        let mig_state = MigrationState::init(state_dir.clone(), false);

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let ssrf_url = "wss://127.0.0.1:9443/api/agent/ws".to_string();
        let sig = migrate::compute_migrate_hmac_hex("tok_ssrf", "nd_ssrf", now, &ssrf_url);
        let directive = MigrateDirective {
            url: ssrf_url,
            fallback_url: None,
            epoch: now,
            sig,
        };

        let err = perform_canary_handshake(&directive, &cfg, &tls_cfg, &mut collector, &mig_state)
            .unwrap_err();
        assert!(err.contains("SSRF guard"), "unexpected error: {err}");

        let _ = std::fs::remove_dir_all(&state_dir);
    }
}
