use std::net::SocketAddr;
use uniob_hub::config::{load_config, CliArgs};
use uniob_hub::db::HubDb;
use uniob_hub::hub_state::HubState;
use uniob_hub::{routes, self_probe, watchdog};

fn print_help() {
    println!(
        "uniob-hub {} — UniOB Self-Hosted Monitoring Hub\n\
         \n\
         Options:\n\
           --config <path>                TOML config path (default: /etc/uniob-hub/hub.toml if present)\n\
           --listen <addr>                Listen address (default: 127.0.0.1:8787)\n\
           --db <path>                    SQLite WAL database path (default: /var/lib/uniob-hub/uniob.db)\n\
           --web-dir <dir>                Frontend dist assets directory\n\
           --releases-dir <dir>           Cached agent release binaries directory\n\
           --public-url <url>             Public origin URL for install script rendering\n\
           --import-bundle <path>         Idempotently import JSON state bundle at startup\n\
           --import-only                  Import --import-bundle and exit cleanly\n\
           --watchdog-url <url>           External CF Watchdog ping endpoint URL\n\
           --watchdog-secret <secret>     HMAC shared secret for Watchdog ping\n\
           --allow-insecure-ws-for-test   Allow ws:// / loopback URLs in hub migrate API\n\
           --version                      Print version and exit\n\
           --help                         Print help and exit",
        env!("CARGO_PKG_VERSION")
    );
}

#[tokio::main]
async fn main() {
    let cli = match CliArgs::parse_from(std::env::args()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[uniob-hub] {e}");
            std::process::exit(2);
        }
    };
    if cli.show_help {
        print_help();
        return;
    }
    if cli.show_version {
        println!("uniob-hub {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let cfg = match load_config(&cli) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[uniob-hub] config error: {e}");
            std::process::exit(1);
        }
    };

    let db = match HubDb::open(&cfg.db_path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[uniob-hub] database error: {e}");
            std::process::exit(1);
        }
    };

    if let Some(ref bundle_path) = cfg.import_bundle {
        match db.import_bundle_file_idempotent(bundle_path) {
            Ok(imported) => {
                if imported {
                    eprintln!("[uniob-hub] imported bundle from {}", bundle_path.display());
                } else {
                    eprintln!(
                        "[uniob-hub] bundle {} already imported (sha256 unchanged)",
                        bundle_path.display()
                    );
                }
            }
            Err(e) => {
                eprintln!("[uniob-hub] failed to import bundle: {e}");
                std::process::exit(1);
            }
        }
    }

    if cfg.import_only {
        return;
    }

    if let Err(e) = db.ensure_session_secret(&cfg.session_secret) {
        eprintln!("[uniob-hub] session secret init failed: {e}");
        std::process::exit(1);
    }

    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let listen_addr = cfg.listen.clone();
    let hub = HubState::new(cfg, db, http);
    hub.spawn_background_tasks();
    self_probe::spawn_self_probe_loop(hub.clone());
    watchdog::spawn_watchdog_loop(hub.clone());

    let app = routes::build_router(hub);
    let listener = match tokio::net::TcpListener::bind(&listen_addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[uniob-hub] failed to bind {listen_addr}: {e}");
            std::process::exit(1);
        }
    };

    eprintln!("[uniob-hub] listening on {listen_addr}");
    if let Err(e) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    {
        eprintln!("[uniob-hub] server error: {e}");
        std::process::exit(1);
    }
}
