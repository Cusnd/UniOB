-- 1. 服务器节点注册表
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT 'Default',
  tags_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  token_sha256 TEXT NOT NULL,
  -- 流量账单配置（针对限流量 VPS）
  traffic_limit_bytes INTEGER DEFAULT NULL,
  traffic_reset_day INTEGER NOT NULL DEFAULT 1,
  traffic_count_mode TEXT NOT NULL DEFAULT 'both',
  -- 静态硬件快照缓存（由 NodeDO 在 hello 握手时异步同步，方便列表页秒开）
  hostname TEXT,
  os TEXT,
  kernel TEXT,
  arch TEXT,
  cpu_model TEXT,
  cpu_cores INTEGER,
  mem_total INTEGER,
  swap_total INTEGER,
  agent_version TEXT,
  proc_enabled INTEGER NOT NULL DEFAULT 1,
  -- 维护静默与时间戳
  mute_until INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_sort ON nodes(sort_order, created_at);

-- 2. 通知渠道表（MVP 首发 Telegram，预留通用 Webhook）
CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 3. 告警规则表（支持全局规则 node_id IS NULL 或单机覆盖规则）
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  node_id TEXT DEFAULT NULL,
  metric TEXT NOT NULL,
  operator TEXT NOT NULL DEFAULT 'gt',
  threshold REAL NOT NULL,
  duration_sec INTEGER NOT NULL DEFAULT 120,
  cooldown_sec INTEGER NOT NULL DEFAULT 3600,
  channel_ids_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- 4. 告警事件历史记录表
CREATE TABLE IF NOT EXISTS alert_incidents (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_value REAL,
  threshold REAL,
  message TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER DEFAULT NULL,
  last_notified_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_node_time ON alert_incidents(node_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON alert_incidents(status, started_at DESC);

-- 5. 系统配置表（用于持久化首次初始化管理员密码哈希与自动生成的 HMAC 会话密钥）
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
