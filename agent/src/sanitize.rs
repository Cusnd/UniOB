use crate::config::CmdlineMode;

const MAX_CMDLINE_CHARS: usize = 256;

const STANDALONE_SENSITIVE_FLAGS: &[&str] = &[
    "p",
    "pass",
    "passwd",
    "password",
    "token",
    "secret",
    "api-key",
    "apikey",
    "access-key",
    "secret-key",
    "auth",
    "bearer",
    "credential",
    "private-key",
];

const KV_SENSITIVE_SUBSTRINGS: &[&str] = &[
    "pass", "pwd", "token", "secret", "key", "auth", "cred", "cookie", "dsn", "jwt",
];

/// Formats and optionally sanitizes raw `\0`-separated Linux `/proc/[pid]/cmdline` bytes.
pub fn format_cmdline(raw_cmdline: &[u8], comm: &str, mode: CmdlineMode) -> String {
    if mode == CmdlineMode::CommOnly {
        return truncate_chars(comm, MAX_CMDLINE_CHARS);
    }

    let args: Vec<String> = raw_cmdline
        .split(|&b| b == 0)
        .filter(|slice| !slice.is_empty())
        .map(|slice| String::from_utf8_lossy(slice).into_owned())
        .collect();

    if args.is_empty() {
        return format!("[{comm}]");
    }

    match mode {
        CmdlineMode::CommOnly => unreachable!(),
        CmdlineMode::Full => truncate_chars(&args.join(" "), MAX_CMDLINE_CHARS),
        CmdlineMode::Sanitized => {
            let sanitized = sanitize_args(&args);
            truncate_chars(&sanitized.join(" "), MAX_CMDLINE_CHARS)
        }
    }
}

fn sanitize_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut mask_next = false;

    for arg in args {
        if mask_next {
            out.push("***".to_string());
            mask_next = false;
            continue;
        }

        // Rule 2: Key-value (`--key=value` or `KEY=value`) split on first `=`.
        if let Some(eq_idx) = arg.find('=') {
            let key = &arg[..eq_idx];
            if is_sensitive_kv_key(key) {
                out.push(format!("{key}=***"));
            } else {
                // Value after `=` might still contain a URI with credentials (e.g. `--db=postgres://u:p@host/db`).
                out.push(mask_uri_credentials(arg));
            }
            continue;
        }

        // Rule 1a: Standalone sensitive flag (case-insensitive after stripping leading `-`).
        if arg.starts_with('-') {
            let flag_name = arg.trim_start_matches('-').to_ascii_lowercase();
            if STANDALONE_SENSITIVE_FLAGS.contains(&flag_name.as_str()) {
                out.push(arg.clone());
                mask_next = true;
                continue;
            }

            // Rule 1b: Compact `-pSecret123` (e.g., mysql/redis-cli) -> `-p***`.
            // Checked AFTER Rule 1a so `-password`, `-pass`, `-passwd`, `-private-key` still mask argv[i+1].
            if arg.starts_with("-p") && arg.len() > 2 && !arg.starts_with("--") {
                out.push("-p***".to_string());
                continue;
            }
        }

        // Rule 3: URI credentials (`scheme://user:password@host...`).
        out.push(mask_uri_credentials(arg));
    }

    out
}

fn is_sensitive_kv_key(key: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    let lower = key.to_ascii_lowercase();
    if KV_SENSITIVE_SUBSTRINGS
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return true;
    }
    if key.starts_with('-') {
        let flag = key.trim_start_matches('-').to_ascii_lowercase();
        if STANDALONE_SENSITIVE_FLAGS.contains(&flag.as_str()) {
            return true;
        }
    }
    false
}

/// Masks password segments inside any `scheme://user:password@host` URI before the first `/`
/// (or `?` / `#`) following `://`.
fn mask_uri_credentials(input: &str) -> String {
    if !input.contains("://") {
        return input.to_string();
    }

    let mut result = String::with_capacity(input.len());
    let mut cursor = 0;

    while let Some(rel_sep) = input[cursor..].find("://") {
        let sep_idx = cursor + rel_sep;
        let auth_start = sep_idx + 3;
        result.push_str(&input[cursor..auth_start]);

        let rest = &input[auth_start..];
        let auth_end_rel = rest.find(['/', '?', '#', ' ', '\t']).unwrap_or(rest.len());
        let authority = &rest[..auth_end_rel];

        if let Some(at_rel) = authority.rfind('@') {
            let userinfo = &authority[..at_rel];
            if let Some(colon_rel) = userinfo.find(':') {
                let user = &userinfo[..colon_rel];
                let host_part = &authority[at_rel..];
                result.push_str(user);
                result.push_str(":***");
                result.push_str(host_part);
            } else {
                result.push_str(authority);
            }
        } else {
            result.push_str(authority);
        }

        cursor = auth_start + auth_end_rel;
    }

    result.push_str(&input[cursor..]);
    result
}

/// Truncates `s` safely on a Unicode scalar boundary at `max_chars` and appends `…` if exceeded.
pub fn truncate_chars(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((byte_idx, _)) => {
            let mut truncated = String::with_capacity(byte_idx + '…'.len_utf8());
            truncated.push_str(&s[..byte_idx]);
            truncated.push('…');
            truncated
        }
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn join_nul(parts: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for part in parts {
            out.extend_from_slice(part.as_bytes());
            out.push(0);
        }
        out
    }

    #[test]
    fn masks_standalone_sensitive_flags_and_compact_p() {
        let raw = join_nul(&[
            "mysql",
            "-h",
            "127.0.0.1",
            "-u",
            "root",
            "-pSuperSecret123",
            "--Token",
            "tok_abc",
            "--API-KEY",
            "ak_999",
            "-P",
            "other_secret",
            "--bearer",
            "eyJhbGciOi",
        ]);
        let res = format_cmdline(&raw, "mysql", CmdlineMode::Sanitized);
        assert_eq!(
            res,
            "mysql -h 127.0.0.1 -u root -p*** --Token *** --API-KEY *** -P *** --bearer ***"
        );
    }

    #[test]
    fn standalone_pass_flags_do_not_trigger_compact_p() {
        let raw = join_nul(&[
            "app",
            "-password",
            "my_pw",
            "-pass",
            "pw2",
            "-private-key",
            "/etc/key",
        ]);
        let res = format_cmdline(&raw, "app", CmdlineMode::Sanitized);
        assert_eq!(res, "app -password *** -pass *** -private-key ***");
    }

    #[test]
    fn masks_all_key_value_sensitive_substrings() {
        let raw = join_nul(&[
            "/usr/bin/worker",
            "--db-password=s3cr3t",
            "MYSQL_PWD=1234",
            "--access_token=abc",
            "CLIENT_SECRET=xyz",
            "--api-key=k123",
            "BASIC_AUTH=dXNlcjpwYXNz",
            "--cred=val",
            "SESSION_COOKIE=abc",
            "--dsn=postgres://foo",
            "JWT=eyJ...",
            "--bearer=tok123",
            "--port=8080",
        ]);
        let res = format_cmdline(&raw, "worker", CmdlineMode::Sanitized);
        assert_eq!(
            res,
            "/usr/bin/worker --db-password=*** MYSQL_PWD=*** --access_token=*** CLIENT_SECRET=*** --api-key=*** BASIC_AUTH=*** --cred=*** SESSION_COOKIE=*** --dsn=*** JWT=*** --bearer=*** --port=8080"
        );
    }

    #[test]
    fn masks_uri_credentials_before_first_slash_only() {
        let raw = join_nul(&[
            "psql",
            "postgres://admin:p@ssword!@db.internal:5432/prod?sslmode=require",
            "--url=https://alice:hunter2@api.example.com/v1/users@active",
            "redis://:redispass@127.0.0.1:6379/0",
            "https://readonly@example.com/path/with:colon@symbol",
        ]);
        let res = format_cmdline(&raw, "psql", CmdlineMode::Sanitized);
        assert_eq!(
            res,
            "psql postgres://admin:***@db.internal:5432/prod?sslmode=require --url=https://alice:***@api.example.com/v1/users@active redis://:***@127.0.0.1:6379/0 https://readonly@example.com/path/with:colon@symbol"
        );
    }

    #[test]
    fn preserves_spaces_inside_args_and_handles_modes_and_kernel_threads() {
        let raw = join_nul(&[
            "/opt/my app/bin",
            "--cfg",
            "/path/with spaces/a.conf",
            "--token",
            "secret",
        ]);
        assert_eq!(
            format_cmdline(&raw, "bin", CmdlineMode::Sanitized),
            "/opt/my app/bin --cfg /path/with spaces/a.conf --token ***"
        );
        assert_eq!(
            format_cmdline(&raw, "bin", CmdlineMode::Full),
            "/opt/my app/bin --cfg /path/with spaces/a.conf --token secret"
        );
        assert_eq!(format_cmdline(&raw, "bin", CmdlineMode::CommOnly), "bin");

        // Empty cmdline falls back to `[comm]` for kernel threads.
        assert_eq!(
            format_cmdline(b"", "kworker/0:1", CmdlineMode::Sanitized),
            "[kworker/0:1]"
        );
        assert_eq!(
            format_cmdline(b"\0\0", "kthreadd", CmdlineMode::Full),
            "[kthreadd]"
        );
    }

    #[test]
    fn truncates_safely_on_unicode_char_boundary_at_256() {
        // 260 multi-byte UTF-8 chars ('中' is 3 bytes each).
        let long_arg = "中".repeat(260);
        let raw = join_nul(&["prog", &long_arg]);
        let res = format_cmdline(&raw, "prog", CmdlineMode::Sanitized);

        assert!(res.ends_with('…'));
        assert_eq!(res.chars().count(), 257);

        // Exact 256 chars should NOT be truncated.
        let exact = "a".repeat(256);
        assert_eq!(
            format_cmdline(exact.as_bytes(), "prog", CmdlineMode::Sanitized),
            exact
        );
    }

    #[test]
    fn handles_extra_uri_schemes_values_with_equals_and_non_utf8() {
        let raw = join_nul(&[
            "svc",
            "amqp://guest:guestpass@mq.local:5672/vhost",
            "mongodb://app:s3cr3t@mongo:27017/db",
            "socks5://proxyuser:proxypass@10.0.0.2:1080",
            "--token=abc=def==",
            "--dsn=postgres://u:p@h/db?sslmode=require",
        ]);
        let res = format_cmdline(&raw, "svc", CmdlineMode::Sanitized);
        assert_eq!(
            res,
            "svc amqp://guest:***@mq.local:5672/vhost mongodb://app:***@mongo:27017/db socks5://proxyuser:***@10.0.0.2:1080 --token=*** --dsn=***"
        );

        let non_utf8 = b"prog\0\xff\xfe\0--secret\0topsecret\0";
        assert_eq!(
            format_cmdline(non_utf8, "prog", CmdlineMode::Sanitized),
            "prog \u{FFFD}\u{FFFD} --secret ***"
        );
    }
}
