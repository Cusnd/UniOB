use crate::crypto::{generate_id, hmac_sha256_hex};
use crate::db::{AlertRuleRuntimeState, HubDb};
use crate::protocol::{
    AlertIncidentRow, AlertRuleRow, CtrlWatermarks, NodeMetricsPayload, NodeRow,
    NodeTrafficSummary, NotificationChannelRow,
};
use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct AlertNotificationPayload {
    pub kind: &'static str, // "firing" | "resolved"
    pub node_id: String,
    pub node_name: String,
    pub group_name: String,
    pub rule_id: String,
    pub rule_name: String,
    pub metric: String,
    pub operator: String,
    pub value_text: String,
    pub value_detail: Option<String>,
    pub threshold_text: String,
    pub duration_sec: i64,
    pub trigger_value: Option<f64>,
    pub threshold: f64,
    pub timestamp_sec: i64,
}

#[derive(Debug, Deserialize)]
struct TelegramChannelConfig {
    bot_token: String,
    chat_id: String,
    #[serde(default)]
    thread_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct WebhookChannelConfig {
    url: String,
    #[serde(default)]
    secret: Option<String>,
}

#[derive(Debug, Serialize)]
struct WebhookBody<'a> {
    event: String,
    kind: &'a str,
    node_id: &'a str,
    node_name: &'a str,
    group_name: &'a str,
    rule_id: &'a str,
    rule_name: &'a str,
    metric: &'a str,
    operator: &'a str,
    value_text: &'a str,
    value_detail: &'a Option<String>,
    threshold_text: &'a str,
    duration_sec: i64,
    trigger_value: Option<f64>,
    threshold: f64,
    timestamp: i64,
}

pub fn compute_recovery_threshold(threshold: f64) -> f64 {
    if threshold > 0.5 {
        (threshold * 0.95).min(threshold - 0.5)
    } else {
        threshold * 0.95
    }
}

pub fn is_threshold_breached(value: f64, operator: &str, threshold: f64) -> bool {
    if operator == "gte" {
        value >= threshold
    } else {
        value > threshold
    }
}

pub fn format_bytes_compact(bytes: f64) -> String {
    if bytes < 1024.0 {
        return format!("{} B", bytes.round() as i64);
    }
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    let mut val = bytes / 1024.0;
    let mut idx = 0;
    while val >= 1024.0 && idx < UNITS.len() - 1 {
        val /= 1024.0;
        idx += 1;
    }
    if val >= 100.0 {
        format!("{val:.0} {}", UNITS[idx])
    } else {
        format!("{val:.1} {}", UNITS[idx])
    }
}

pub fn format_threshold_text(metric: &str, threshold: f64) -> String {
    if metric == "offline" {
        format!("{}s", threshold.round() as i64)
    } else {
        format!("{threshold:.1}%")
    }
}

pub fn compute_watermarks_for_node(
    node_id: &str,
    rules: &[AlertRuleRow],
) -> Option<CtrlWatermarks> {
    let mut wm = CtrlWatermarks::default();
    for r in rules {
        if r.enabled == 0 {
            continue;
        }
        if let Some(ref target) = r.node_id {
            if target != node_id {
                continue;
            }
        }
        let slot = match r.metric.as_str() {
            "cpu" => &mut wm.cpu,
            "steal" => &mut wm.steal,
            "mem" => &mut wm.mem,
            "swap" => &mut wm.swap,
            "disk" => &mut wm.disk,
            _ => continue,
        };
        if r.threshold.is_finite() && r.threshold > 0.0 {
            *slot = Some(match *slot {
                Some(prev) => prev.min(r.threshold),
                None => r.threshold,
            });
        }
    }
    if wm.is_empty() {
        None
    } else {
        Some(wm)
    }
}

pub fn extract_metric_reading(
    metric: &str,
    node: &NodeRow,
    traffic: &NodeTrafficSummary,
    metrics: &NodeMetricsPayload,
) -> Option<(f64, String, Option<String>)> {
    match metric {
        "cpu" => {
            let val = metrics.cpu.all;
            let load1 = metrics.cpu.load.first().copied().unwrap_or(0.0);
            Some((val, format!("{val:.1}%"), Some(format!("Load {load1:.2}"))))
        }
        "steal" => {
            let val = metrics.cpu.steal;
            Some((val, format!("{val:.1}%"), None))
        }
        "mem" => {
            let total = match node.mem_total {
                Some(t) if t > 0 => t as f64,
                _ => (metrics.mem.used.saturating_add(metrics.mem.avail)) as f64,
            };
            if total <= 0.0 {
                return None;
            }
            let val = (metrics.mem.used as f64 / total) * 100.0;
            Some((
                val,
                format!("{val:.1}%"),
                Some(format!(
                    "{} / {}",
                    format_bytes_compact(metrics.mem.used as f64),
                    format_bytes_compact(total)
                )),
            ))
        }
        "swap" => {
            let total = node.swap_total.unwrap_or(0) as f64;
            if total <= 0.0 {
                return None;
            }
            let val = (metrics.mem.swap_used as f64 / total) * 100.0;
            Some((
                val,
                format!("{val:.1}%"),
                Some(format!(
                    "{} / {}",
                    format_bytes_compact(metrics.mem.swap_used as f64),
                    format_bytes_compact(total)
                )),
            ))
        }
        "disk" => {
            let mut max_pct = -1.0_f64;
            let mut max_disk = None;
            for d in &metrics.disks {
                if d.total > 0 {
                    let pct = (d.used as f64 / d.total as f64) * 100.0;
                    if pct > max_pct {
                        max_pct = pct;
                        max_disk = Some(d);
                    }
                }
            }
            let d = max_disk?;
            Some((
                max_pct,
                format!("{max_pct:.1}%"),
                Some(format!(
                    "{} {} / {}",
                    d.mp,
                    format_bytes_compact(d.used as f64),
                    format_bytes_compact(d.total as f64)
                )),
            ))
        }
        "traffic_pct" => {
            let limit = traffic.limit_bytes.unwrap_or(0);
            if limit <= 0 {
                return None;
            }
            let val = (traffic.counted_bytes as f64 / limit as f64) * 100.0;
            Some((
                val,
                format!("{val:.1}%"),
                Some(format!(
                    "{} / {}",
                    format_bytes_compact(traffic.counted_bytes as f64),
                    format_bytes_compact(limit as f64)
                )),
            ))
        }
        _ => None,
    }
}

pub enum RuleAction {
    None,
    Fire {
        incident_id: String,
    },
    Renotify {
        incident_id: String,
    },
    Resolve {
        incident_id: String,
        outage_sec: i64,
    },
}

pub fn evaluate_rule_step(
    rule: &AlertRuleRow,
    prev_opt: Option<&AlertRuleRuntimeState>,
    value: f64,
    now_sec: i64,
) -> (AlertRuleRuntimeState, RuleAction, bool) {
    let prev = prev_opt.cloned().unwrap_or(AlertRuleRuntimeState {
        rule_id: rule.id.clone(),
        state: "OK".to_string(),
        first_breach_ts: None,
        last_notified_ts: None,
        recover_ok_count: 0,
        incident_id: None,
        started_at: None,
    });

    let breached = is_threshold_breached(value, &rule.operator, rule.threshold);

    match prev.state.as_str() {
        "OK" => {
            if !breached {
                return (prev, RuleAction::None, false);
            }
            if rule.duration_sec <= 0 {
                let inc_id =
                    generate_id("inc").unwrap_or_else(|_| format!("inc_{}_{}", rule.id, now_sec));
                let next = AlertRuleRuntimeState {
                    rule_id: rule.id.clone(),
                    state: "FIRING".to_string(),
                    first_breach_ts: Some(now_sec),
                    last_notified_ts: Some(now_sec),
                    recover_ok_count: 0,
                    incident_id: Some(inc_id.clone()),
                    started_at: Some(now_sec),
                };
                return (
                    next,
                    RuleAction::Fire {
                        incident_id: inc_id,
                    },
                    true,
                );
            }
            let next = AlertRuleRuntimeState {
                rule_id: rule.id.clone(),
                state: "PENDING".to_string(),
                first_breach_ts: Some(now_sec),
                last_notified_ts: None,
                recover_ok_count: 0,
                incident_id: None,
                started_at: None,
            };
            (next, RuleAction::None, true)
        }
        "PENDING" => {
            if !breached {
                let next = AlertRuleRuntimeState {
                    rule_id: rule.id.clone(),
                    state: "OK".to_string(),
                    first_breach_ts: None,
                    last_notified_ts: None,
                    recover_ok_count: 0,
                    incident_id: None,
                    started_at: None,
                };
                return (next, RuleAction::None, true);
            }
            let first = prev.first_breach_ts.unwrap_or(now_sec);
            if now_sec - first >= rule.duration_sec {
                let inc_id =
                    generate_id("inc").unwrap_or_else(|_| format!("inc_{}_{}", rule.id, now_sec));
                let next = AlertRuleRuntimeState {
                    rule_id: rule.id.clone(),
                    state: "FIRING".to_string(),
                    first_breach_ts: Some(first),
                    last_notified_ts: Some(now_sec),
                    recover_ok_count: 0,
                    incident_id: Some(inc_id.clone()),
                    started_at: Some(now_sec),
                };
                return (
                    next,
                    RuleAction::Fire {
                        incident_id: inc_id,
                    },
                    true,
                );
            }
            (prev, RuleAction::None, false)
        }
        _ => {
            // FIRING
            let recovery = compute_recovery_threshold(rule.threshold);
            let recovered_now = value < recovery;
            if recovered_now {
                let ok_count = prev.recover_ok_count + 1;
                if ok_count >= 2 {
                    let inc_id = prev.incident_id.clone().unwrap_or_else(|| {
                        format!("inc_{}_{}", rule.id, prev.started_at.unwrap_or(now_sec))
                    });
                    let outage = (now_sec - prev.started_at.unwrap_or(now_sec)).max(0);
                    let next = AlertRuleRuntimeState {
                        rule_id: rule.id.clone(),
                        state: "OK".to_string(),
                        first_breach_ts: None,
                        last_notified_ts: None,
                        recover_ok_count: 0,
                        incident_id: None,
                        started_at: None,
                    };
                    return (
                        next,
                        RuleAction::Resolve {
                            incident_id: inc_id,
                            outage_sec: outage,
                        },
                        true,
                    );
                }
                let mut next = prev;
                next.recover_ok_count = ok_count;
                return (next, RuleAction::None, true);
            }

            let mut next = prev;
            let mut changed = false;
            if next.recover_ok_count != 0 {
                next.recover_ok_count = 0;
                changed = true;
            }
            if breached
                && rule.cooldown_sec > 0
                && now_sec - next.last_notified_ts.unwrap_or(0) >= rule.cooldown_sec
            {
                let inc_id = next.incident_id.clone().unwrap_or_default();
                next.last_notified_ts = Some(now_sec);
                return (
                    next,
                    RuleAction::Renotify {
                        incident_id: inc_id,
                    },
                    true,
                );
            }
            (next, RuleAction::None, changed)
        }
    }
}

pub fn get_offline_threshold_sec(node_id: &str, rules: &[AlertRuleRow]) -> i64 {
    let mut min_sec: Option<i64> = None;
    for r in rules {
        if r.enabled == 0 || r.metric != "offline" {
            continue;
        }
        if let Some(ref target) = r.node_id {
            if target != node_id {
                continue;
            }
        }
        let t = r.threshold.round() as i64;
        if t > 0 {
            min_sec = Some(match min_sec {
                Some(prev) => prev.min(t),
                None => t,
            });
        }
    }
    min_sec.unwrap_or(90).clamp(15, 3600)
}

pub fn evaluate_node_metrics_alerts(
    db: &HubDb,
    http: &reqwest::Client,
    node: &NodeRow,
    traffic: &NodeTrafficSummary,
    metrics: &NodeMetricsPayload,
    now_sec: i64,
) -> Result<(bool, Vec<AlertNotificationPayload>), String> {
    let rules = db.list_rules()?;
    let states = db.load_rule_states(&node.id)?;
    let state_map: HashMap<String, AlertRuleRuntimeState> =
        states.into_iter().map(|s| (s.rule_id.clone(), s)).collect();

    let mut notifications = Vec::new();
    let mut alert_changed = false;

    for r in rules {
        if r.enabled == 0 || r.metric == "offline" {
            continue;
        }
        if let Some(ref target) = r.node_id {
            if target != &node.id {
                continue;
            }
        }

        let Some((val, value_text, value_detail)) =
            extract_metric_reading(&r.metric, node, traffic, metrics)
        else {
            continue;
        };

        let (next_state, action, changed) =
            evaluate_rule_step(&r, state_map.get(&r.id), val, now_sec);
        if changed {
            if next_state.state == "OK" {
                db.delete_rule_state(&node.id, &r.id)?;
            } else {
                db.save_rule_state(&node.id, &next_state)?;
            }
        }

        let threshold_text = format_threshold_text(&r.metric, r.threshold);
        match action {
            RuleAction::Fire { incident_id } => {
                alert_changed = true;
                let op_sym = if r.operator == "gte" { ">=" } else { ">" };
                db.record_incident_firing(&AlertIncidentRow {
                    id: incident_id,
                    node_id: node.id.clone(),
                    node_name: node.name.clone(),
                    rule_id: r.id.clone(),
                    metric: r.metric.clone(),
                    status: "firing".to_string(),
                    trigger_value: Some(val),
                    threshold: Some(r.threshold),
                    message: format!(
                        "{}: 当前 {} ({} {})",
                        r.name, value_text, op_sym, threshold_text
                    ),
                    started_at: now_sec,
                    resolved_at: None,
                    last_notified_at: now_sec,
                })?;
                if !is_muted(node.mute_until, now_sec) {
                    notifications.push(AlertNotificationPayload {
                        kind: "firing",
                        node_id: node.id.clone(),
                        node_name: node.name.clone(),
                        group_name: node.group_name.clone(),
                        rule_id: r.id.clone(),
                        rule_name: r.name.clone(),
                        metric: r.metric.clone(),
                        operator: r.operator.clone(),
                        value_text,
                        value_detail,
                        threshold_text,
                        duration_sec: r.duration_sec,
                        trigger_value: Some(val),
                        threshold: r.threshold,
                        timestamp_sec: now_sec,
                    });
                }
            }
            RuleAction::Renotify { incident_id } => {
                if !incident_id.is_empty() {
                    db.record_incident_renotify(&incident_id, now_sec)?;
                }
                if !is_muted(node.mute_until, now_sec) {
                    notifications.push(AlertNotificationPayload {
                        kind: "firing",
                        node_id: node.id.clone(),
                        node_name: node.name.clone(),
                        group_name: node.group_name.clone(),
                        rule_id: r.id.clone(),
                        rule_name: r.name.clone(),
                        metric: r.metric.clone(),
                        operator: r.operator.clone(),
                        value_text,
                        value_detail,
                        threshold_text,
                        duration_sec: r.duration_sec,
                        trigger_value: Some(val),
                        threshold: r.threshold,
                        timestamp_sec: now_sec,
                    });
                }
            }
            RuleAction::Resolve {
                incident_id,
                outage_sec,
            } => {
                alert_changed = true;
                db.record_incident_resolved(&incident_id, now_sec)?;
                if !is_muted(node.mute_until, now_sec) {
                    notifications.push(AlertNotificationPayload {
                        kind: "resolved",
                        node_id: node.id.clone(),
                        node_name: node.name.clone(),
                        group_name: node.group_name.clone(),
                        rule_id: r.id.clone(),
                        rule_name: r.name.clone(),
                        metric: r.metric.clone(),
                        operator: r.operator.clone(),
                        value_text,
                        value_detail,
                        threshold_text,
                        duration_sec: outage_sec,
                        trigger_value: Some(val),
                        threshold: r.threshold,
                        timestamp_sec: now_sec,
                    });
                }
            }
            RuleAction::None => {}
        }
    }

    if !notifications.is_empty() {
        spawn_notifications(db.clone(), http.clone(), notifications.clone());
    }

    Ok((alert_changed, notifications))
}

pub fn evaluate_node_offline_alerts(
    db: &HubDb,
    http: &reqwest::Client,
    node: &NodeRow,
    elapsed_sec: i64,
    now_sec: i64,
) -> Result<bool, String> {
    let rules = db.list_rules()?;
    let states = db.load_rule_states(&node.id)?;
    let state_map: HashMap<String, AlertRuleRuntimeState> =
        states.into_iter().map(|s| (s.rule_id.clone(), s)).collect();

    let mut changed = false;
    let mut notifications = Vec::new();
    for r in rules {
        if r.enabled == 0 || r.metric != "offline" {
            continue;
        }
        if let Some(ref target) = r.node_id {
            if target != &node.id {
                continue;
            }
        }
        let threshold_text = format_threshold_text("offline", r.threshold);
        if let Some(prev) = state_map.get(&r.id) {
            if prev.state == "FIRING" {
                if r.cooldown_sec > 0
                    && now_sec - prev.last_notified_ts.unwrap_or(0) >= r.cooldown_sec
                {
                    let mut next = prev.clone();
                    next.last_notified_ts = Some(now_sec);
                    db.save_rule_state(&node.id, &next)?;
                    if let Some(ref inc_id) = prev.incident_id {
                        db.record_incident_renotify(inc_id, now_sec)?;
                    }
                    if !is_muted(node.mute_until, now_sec) {
                        notifications.push(AlertNotificationPayload {
                            kind: "firing",
                            node_id: node.id.clone(),
                            node_name: node.name.clone(),
                            group_name: node.group_name.clone(),
                            rule_id: r.id.clone(),
                            rule_name: r.name.clone(),
                            metric: "offline".to_string(),
                            operator: r.operator.clone(),
                            value_text: format!("已离线 {elapsed_sec}s"),
                            value_detail: None,
                            threshold_text,
                            duration_sec: r.duration_sec,
                            trigger_value: Some(elapsed_sec as f64),
                            threshold: r.threshold,
                            timestamp_sec: now_sec,
                        });
                    }
                }
                continue;
            }
        }

        let inc_id = format!("{}_off_{now_sec}", node.id);
        db.save_rule_state(
            &node.id,
            &AlertRuleRuntimeState {
                rule_id: r.id.clone(),
                state: "FIRING".to_string(),
                first_breach_ts: Some(now_sec - elapsed_sec),
                last_notified_ts: Some(now_sec),
                recover_ok_count: 0,
                incident_id: Some(inc_id.clone()),
                started_at: Some(now_sec),
            },
        )?;
        db.record_incident_firing(&AlertIncidentRow {
            id: inc_id,
            node_id: node.id.clone(),
            node_name: node.name.clone(),
            rule_id: r.id.clone(),
            metric: "offline".to_string(),
            status: "firing".to_string(),
            trigger_value: Some(elapsed_sec as f64),
            threshold: Some(r.threshold),
            message: format!("{}: 节点失联超过 {elapsed_sec}s", r.name),
            started_at: now_sec,
            resolved_at: None,
            last_notified_at: now_sec,
        })?;
        changed = true;
        if !is_muted(node.mute_until, now_sec) {
            notifications.push(AlertNotificationPayload {
                kind: "firing",
                node_id: node.id.clone(),
                node_name: node.name.clone(),
                group_name: node.group_name.clone(),
                rule_id: r.id.clone(),
                rule_name: r.name.clone(),
                metric: "offline".to_string(),
                operator: r.operator.clone(),
                value_text: format!("已离线 {elapsed_sec}s"),
                value_detail: None,
                threshold_text,
                duration_sec: r.duration_sec,
                trigger_value: Some(elapsed_sec as f64),
                threshold: r.threshold,
                timestamp_sec: now_sec,
            });
        }
    }

    if !notifications.is_empty() {
        spawn_notifications(db.clone(), http.clone(), notifications);
    }
    Ok(changed)
}

pub fn resolve_offline_rules_if_firing(
    db: &HubDb,
    http: &reqwest::Client,
    node: &NodeRow,
    now_sec: i64,
) -> Result<bool, String> {
    let rules = db.list_rules()?;
    let rule_map: HashMap<String, AlertRuleRow> =
        rules.into_iter().map(|r| (r.id.clone(), r)).collect();
    let states = db.load_rule_states(&node.id)?;

    let mut resolved_any = false;
    let mut notifications = Vec::new();
    for st in states {
        let Some(r) = rule_map.get(&st.rule_id) else {
            continue;
        };
        if r.metric != "offline" || st.state != "FIRING" {
            continue;
        }
        let outage_sec = (now_sec - st.started_at.unwrap_or(now_sec)).max(0);
        if let Some(ref inc_id) = st.incident_id {
            db.record_incident_resolved(inc_id, now_sec)?;
        }
        db.delete_rule_state(&node.id, &r.id)?;
        resolved_any = true;
        if !is_muted(node.mute_until, now_sec) {
            notifications.push(AlertNotificationPayload {
                kind: "resolved",
                node_id: node.id.clone(),
                node_name: node.name.clone(),
                group_name: node.group_name.clone(),
                rule_id: r.id.clone(),
                rule_name: r.name.clone(),
                metric: "offline".to_string(),
                operator: r.operator.clone(),
                value_text: "已恢复在线".to_string(),
                value_detail: None,
                threshold_text: format_threshold_text("offline", r.threshold),
                duration_sec: outage_sec,
                trigger_value: Some(0.0),
                threshold: r.threshold,
                timestamp_sec: now_sec,
            });
        }
    }

    if !notifications.is_empty() {
        spawn_notifications(db.clone(), http.clone(), notifications);
    }
    Ok(resolved_any)
}

fn is_muted(mute_until: Option<i64>, now_sec: i64) -> bool {
    matches!(mute_until, Some(m) if m > now_sec)
}

fn spawn_notifications(db: HubDb, http: reqwest::Client, payloads: Vec<AlertNotificationPayload>) {
    let Ok(channels) = db.list_channels() else {
        return;
    };
    let rules = db.list_rules().unwrap_or_default();
    let rule_channels: HashMap<String, Vec<String>> = rules
        .into_iter()
        .map(|r| {
            let ids: Vec<String> = serde_json::from_str(&r.channel_ids_json).unwrap_or_default();
            (r.id, ids)
        })
        .collect();
    let ch_map: HashMap<String, NotificationChannelRow> = channels
        .into_iter()
        .filter(|c| c.enabled != 0)
        .map(|c| (c.id.clone(), c))
        .collect();

    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            for p in payloads {
                let ids = rule_channels.get(&p.rule_id).cloned().unwrap_or_default();
                for ch_id in ids {
                    if let Some(ch) = ch_map.get(&ch_id) {
                        let _ = send_channel_notification(&http, ch, &p).await;
                    }
                }
            }
        });
    }
}

pub async fn send_channel_notification(
    http: &reqwest::Client,
    ch: &NotificationChannelRow,
    payload: &AlertNotificationPayload,
) -> Result<(), String> {
    let mut last_err = String::new();
    for attempt in 0..3u64 {
        let res = match ch.channel_type.as_str() {
            "telegram" => send_telegram(http, &ch.config_json, payload).await,
            "webhook" => send_webhook(http, &ch.config_json, payload).await,
            other => return Err(format!("Unsupported channel type: {other}")),
        };
        match res {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e;
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(500 * (1 << attempt))).await;
                }
            }
        }
    }
    Err(last_err)
}

async fn send_telegram(
    http: &reqwest::Client,
    config_json: &str,
    payload: &AlertNotificationPayload,
) -> Result<(), String> {
    let cfg: TelegramChannelConfig =
        serde_json::from_str(config_json).map_err(|e| format!("Invalid Telegram config: {e}"))?;
    let text = format_telegram_html(payload);
    let url = format!("https://api.telegram.org/bot{}/sendMessage", cfg.bot_token);
    let mut body = serde_json::json!({
        "chat_id": cfg.chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": true,
    });
    if let Some(tid) = cfg.thread_id {
        body["message_thread_id"] = serde_json::json!(tid);
    }
    let resp = http
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Telegram request error: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Telegram HTTP {}", resp.status()));
    }
    Ok(())
}

async fn send_webhook(
    http: &reqwest::Client,
    config_json: &str,
    payload: &AlertNotificationPayload,
) -> Result<(), String> {
    let cfg: WebhookChannelConfig =
        serde_json::from_str(config_json).map_err(|e| format!("Invalid Webhook config: {e}"))?;
    let body_struct = WebhookBody {
        event: format!("alert.{}", payload.kind),
        kind: payload.kind,
        node_id: &payload.node_id,
        node_name: &payload.node_name,
        group_name: &payload.group_name,
        rule_id: &payload.rule_id,
        rule_name: &payload.rule_name,
        metric: &payload.metric,
        operator: &payload.operator,
        value_text: &payload.value_text,
        value_detail: &payload.value_detail,
        threshold_text: &payload.threshold_text,
        duration_sec: payload.duration_sec,
        trigger_value: payload.trigger_value,
        threshold: payload.threshold,
        timestamp: payload.timestamp_sec,
    };
    let raw_body =
        serde_json::to_string(&body_struct).map_err(|e| format!("Webhook JSON error: {e}"))?;
    let mut req = http
        .post(&cfg.url)
        .header("Content-Type", "application/json");
    if let Some(ref secret) = cfg.secret {
        if !secret.is_empty() {
            let sig = format!(
                "sha256={}",
                hmac_sha256_hex(secret.as_bytes(), raw_body.as_bytes())
            );
            req = req.header("X-UniOB-Signature", sig);
        }
    }
    let resp = req
        .body(raw_body)
        .send()
        .await
        .map_err(|e| format!("Webhook request error: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Webhook HTTP {}", resp.status()));
    }
    Ok(())
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn format_utc_plus8(ts_sec: i64) -> String {
    let shifted = Utc
        .timestamp_opt(ts_sec + 8 * 3600, 0)
        .single()
        .unwrap_or_else(|| Utc.timestamp_opt(0, 0).unwrap());
    shifted.format("%Y-%m-%d %H:%M:%S UTC+8").to_string()
}

fn format_duration_zh(total_sec: i64) -> String {
    let sec = total_sec.max(0);
    if sec < 60 {
        format!("{sec} 秒")
    } else if sec < 3600 {
        format!("{} 分 {} 秒", sec / 60, sec % 60)
    } else if sec < 86400 {
        format!(
            "{} 小时 {} 分 {} 秒",
            sec / 3600,
            (sec % 3600) / 60,
            sec % 60
        )
    } else {
        format!(
            "{} 天 {} 小时 {} 分",
            sec / 86400,
            (sec % 86400) / 3600,
            (sec % 3600) / 60
        )
    }
}

pub fn format_telegram_html(payload: &AlertNotificationPayload) -> String {
    let node_name = escape_html(if payload.node_name.is_empty() {
        &payload.node_id
    } else {
        &payload.node_name
    });
    let group_name = escape_html(if payload.group_name.is_empty() {
        "Default"
    } else {
        &payload.group_name
    });
    let rule_name = escape_html(&payload.rule_name);
    let value_text = escape_html(&payload.value_text);
    let detail_suffix = payload
        .value_detail
        .as_deref()
        .map(|d| format!(" ({})", escape_html(d)))
        .unwrap_or_default();
    let time_str = format_utc_plus8(payload.timestamp_sec);

    if payload.kind == "firing" {
        let op_sym = if payload.operator == "gte" {
            "&gt;="
        } else {
            "&gt;"
        };
        let threshold_str = escape_html(&payload.threshold_text);
        let condition = if payload.metric == "offline" {
            format!("断连超过 {threshold_str}")
        } else if payload.duration_sec > 0 {
            format!("{op_sym} {threshold_str} 持续 {}s", payload.duration_sec)
        } else {
            format!("{op_sym} {threshold_str}")
        };
        format!(
            "🚨 <b>[UniOB 告警触发]</b>\n<b>节点：</b>{node_name} (<code>{group_name}</code>)\n<b>项目：</b>{rule_name}\n<b>当前值：</b><code>{value_text}</code>{detail_suffix}\n<b>触发条件：</b>{condition}\n<b>时间：</b>{time_str}"
        )
    } else {
        let dur_str = format_duration_zh(payload.duration_sec);
        format!(
            "✅ <b>[UniOB 告警恢复]</b>\n<b>节点：</b>{node_name} (<code>{group_name}</code>)\n<b>项目：</b>{rule_name}\n<b>当前值：</b><code>{value_text}</code>{detail_suffix}\n<b>持续时长：</b>{dur_str}\n<b>时间：</b>{time_str}"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CpuMetrics, MemMetrics, NetMetrics};

    #[test]
    fn rule_state_machine_fires_hysteresis_and_resolves() {
        let rule = AlertRuleRow {
            id: "rule_cpu".into(),
            name: "High CPU".into(),
            node_id: None,
            metric: "cpu".into(),
            operator: "gt".into(),
            threshold: 90.0,
            duration_sec: 60,
            cooldown_sec: 300,
            channel_ids_json: "[]".into(),
            enabled: 1,
            created_at: 1_700_000_000,
        };

        // Initial breach -> PENDING
        let (st1, act1, _) = evaluate_rule_step(&rule, None, 95.0, 1000);
        assert_eq!(st1.state, "PENDING");
        assert!(matches!(act1, RuleAction::None));

        // Sustained >= 60s -> FIRING
        let (st2, act2, _) = evaluate_rule_step(&rule, Some(&st1), 92.0, 1060);
        assert_eq!(st2.state, "FIRING");
        assert!(matches!(act2, RuleAction::Fire { .. }));

        // Within hysteresis band (90 - 3 = 87, recovery threshold is min(85.5, 89.5) = 85.5): stays FIRING
        let (st3, act3, _) = evaluate_rule_step(&rule, Some(&st2), 86.0, 1090);
        assert_eq!(st3.state, "FIRING");
        assert!(matches!(act3, RuleAction::None));

        // Two consecutive samples below 85.5 -> RESOLVED
        let (st4, act4, _) = evaluate_rule_step(&rule, Some(&st3), 80.0, 1120);
        assert_eq!(st4.state, "FIRING");
        assert_eq!(st4.recover_ok_count, 1);
        assert!(matches!(act4, RuleAction::None));

        let (st5, act5, _) = evaluate_rule_step(&rule, Some(&st4), 79.0, 1150);
        assert_eq!(st5.state, "OK");
        assert!(matches!(act5, RuleAction::Resolve { .. }));
    }

    #[test]
    fn watermarks_picks_lowest_active_threshold() {
        let rules = vec![
            AlertRuleRow {
                id: "r1".into(),
                name: "CPU 90".into(),
                node_id: None,
                metric: "cpu".into(),
                operator: "gt".into(),
                threshold: 90.0,
                duration_sec: 60,
                cooldown_sec: 300,
                channel_ids_json: "[]".into(),
                enabled: 1,
                created_at: 0,
            },
            AlertRuleRow {
                id: "r2".into(),
                name: "CPU 80 Node1".into(),
                node_id: Some("n1".into()),
                metric: "cpu".into(),
                operator: "gt".into(),
                threshold: 80.0,
                duration_sec: 0,
                cooldown_sec: 300,
                channel_ids_json: "[]".into(),
                enabled: 1,
                created_at: 0,
            },
            AlertRuleRow {
                id: "r3".into(),
                name: "Disabled Mem".into(),
                node_id: None,
                metric: "mem".into(),
                operator: "gt".into(),
                threshold: 70.0,
                duration_sec: 0,
                cooldown_sec: 300,
                channel_ids_json: "[]".into(),
                enabled: 0,
                created_at: 0,
            },
        ];

        let wm_n1 = compute_watermarks_for_node("n1", &rules).unwrap();
        assert_eq!(wm_n1.cpu, Some(80.0));
        assert_eq!(wm_n1.mem, None);

        let wm_n2 = compute_watermarks_for_node("n2", &rules).unwrap();
        assert_eq!(wm_n2.cpu, Some(90.0));
    }

    #[test]
    fn extract_metric_computes_percentages() {
        let node = NodeRow {
            id: "n1".into(),
            name: "N1".into(),
            group_name: "Default".into(),
            tags_json: "[]".into(),
            sort_order: 0,
            token_sha256: String::new(),
            traffic_limit_bytes: Some(1000),
            traffic_reset_day: 1,
            traffic_count_mode: "both".into(),
            hostname: None,
            os: None,
            kernel: None,
            arch: None,
            cpu_model: None,
            cpu_cores: None,
            mem_total: Some(1000),
            swap_total: Some(500),
            agent_version: None,
            proc_enabled: 1,
            mute_until: None,
            created_at: 0,
            updated_at: 0,
        };
        let traffic = NodeTrafficSummary {
            limit_bytes: Some(1000),
            reset_day: 1,
            count_mode: "both".into(),
            cycle_key: "2026-11".into(),
            rx_bytes: 200,
            tx_bytes: 300,
            counted_bytes: 500,
            days_remaining: 10,
        };
        let metrics = NodeMetricsPayload {
            ts: 1000,
            up: 60,
            cpu: CpuMetrics {
                all: 42.5,
                cores: vec![],
                steal: 1.5,
                iowait: 0.5,
                load: vec![0.8],
            },
            mem: MemMetrics {
                used: 750,
                avail: 250,
                cached: 100,
                swap_used: 100,
            },
            disks: vec![],
            net: NetMetrics {
                rx_bps: 10,
                tx_bps: 20,
                rx_tot: 100,
                tx_tot: 200,
                tcp_est: 2,
                tcp_tw: 0,
                udp: 1,
            },
        };
        assert_eq!(
            extract_metric_reading("mem", &node, &traffic, &metrics)
                .unwrap()
                .0,
            75.0
        );
        assert_eq!(
            extract_metric_reading("swap", &node, &traffic, &metrics)
                .unwrap()
                .0,
            20.0
        );
        assert_eq!(
            extract_metric_reading("traffic_pct", &node, &traffic, &metrics)
                .unwrap()
                .0,
            50.0
        );
    }
}
