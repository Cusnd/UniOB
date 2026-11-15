# Network quality v1 implementation contract

This working contract implements [the feature specification](network-quality.md) on the current Atelier UI. Optional extensions must not break existing resource telemetry.

## Configuration and IDs

`Target = {id: "ct"|"cu"|"cm", enabled: boolean, label: string, region: string, host: string, port: number, address_family: "ipv4"}`.

`Config = {enabled: boolean, targets: Target[]}` (exactly the three slots, normalized in ct/cu/cm order). Defaults disabled globally, all target slots enabled, labels 电信/联通/移动, region 广东, hosts gd-{ct,cu,cm}-v4.ip.zstaticcdn.com, port 80.

`NodeOverride = {mode: "inherit"|"off"|"custom", config?: Config}`. Global settings key `network_quality_config`, node key `network_quality_node:<id>`.

Normalize host trim/lowercase, label/region trim, reject unknown fields or invalid types at management boundaries. Label/region length 1..64 chars; host ASCII DNS or IPv4 max 253; no URLs, colon, path, credentials, wildcard; IPv4 literals must be public. Port integer 1..65535. No implicit enabling.

Stable IDs use SHA256 hex of UTF-8 JSON, without spaces:

- target array: `[id,enabled,label,region,host,port,"ipv4"]`
- target_revision: SHA256 of target array.
- config_id: SHA256 of `["network_quality_v1",enabled,[targetArrayCT,targetArrayCU,targetArrayCM]]`.

`Control = {schema_version:1,config_id:string,enabled:boolean,targets:(Target & {target_revision:string})[]}`. Intervals fixed in code: 20s probe, 120s window, 1500ms connect and separate DNS budget.

All config GET/PUT replies: `{config: Config|NodeOverride, effective_config: Control, config_id: string, applied_config_id: string|null, supported: boolean}`. For global replies applied=null, supported=true. PUT bodies are directly Config or NodeOverride. Missing global settings default disabled. Missing node settings default inherit. Return 400 on invalid input, 404 unknown node. Interfaces use existing admin auth.

## Agent extension

Hello capability `network_quality_v1`. First ctrl of each supported connection includes full control under `network_quality`. Later omitted field means unchanged. Parse extension separately from resource/control fields.

`Point = {sample_id:string,round_seq:number,config_id:string,target_id:"ct"|"cu"|"cm",target_revision:string,segment_id:string,ts:number,result:Result,connect_ms:number|null,remote_ip:string|null,target:Target}`.

Result = ok | connect_timeout | connection_refused | dns_error | dns_timeout | network_error. Invalid/blocked configuration is a config_error, not a completed attempt. Successful points have nonnegative finite connect_ms and a public IPv4 remote_ip. Failed points connect_ms=null; DNS failures remote_ip=null. All IDs max 160 chars; timestamps integer Unix seconds. Point metadata allows historic target reconstruction.

`Latest = {target_id,target_revision,segment_id,target,measured_at,result,remote_ip,latency_median_ms:number|null,attempts:number,failures:number,failure_rate_pct:number|null}`.

`Payload = {schema_version:1,applied_config_id:string|null,enabled:boolean,config_error:string|null,dropped_samples:number,latest:Latest[],points:Point[]}`. Payload is optional top-level `network_quality` in m and mb, never in the 16-item tuple. Snapshot copies remove `points`. Latest is independently recomputed/validated against raw samples by the receiving backend; empty points keep previous accepted latest. Config acknowledgement / disabled state is still accepted with empty points.

Payload limit 128 KiB UTF-8 and 270 points. Session-scoped sample IDs and segments; never rewrite measurement timestamps. Drop oldest unsent points beyond 30m/270. A malformed extension must not reject a valid resource/control frame. Queue is best effort, released after successful send, retained on send failure. Do not create additional application-level messages.

## API / front end

- GET/PUT `/api/network-quality/config`
- GET/PUT `/api/nodes/:id/network-quality/config`
- GET `/api/nodes/:id/network-quality?range=1h|24h|7d|30d&cursor=<optional>`

`State = {supported:boolean,enabled:boolean,applied_config_id:string|null,config_error:string|null,dropped_samples:number,latest:Latest[]}`.

Optional resource snapshot field `network_quality: State`. For detail WS updates include network_quality in metrics; frontend may query quality history once on entering/changing node/range, then append truly new latest samples or refresh history on new measurement (at most once/20s while visible). It must not start a hidden independent polling loop. Quality panel also loads config and exposes node inherit/custom/off controls; global controls belong in node management.

`Query = {node_id,range,resolution_sec:20|300,server_time,state:State,series:{target_id,points:QueryPoint[]}[],next_cursor:string|null}`.

`QueryPoint = {ts:number,segment_id:string,target_revision:string,target:Target,remote_ip:string|null,round_seq:number|null,result:Result|null,latency_ms:number|null,latency_max_ms:number|null,attempts:number,failures:number,success_count:number,latency_sum_ms:number,failure_rate_pct:number|null}`.

For 1h/24h each point is a raw attempt with latency_ms=connect_ms and attempts/failures from its trailing 120s segment window (max6), success_count and latency_sum match that window, failure_rate is rolling. For 7d/30d each point is one segment in a UTC 5m bucket; mean latency and counts derive only from that segment's raw attempts. Flattening segments in response is okay; pagination max 3000 query points and 1,000,000 UTF-8 bytes of serialized points across all three series ordered by `(ts,target_id,segment_id)`. The opaque cursor pins query end time, storage block and offset within that block; query processing decodes one block at a time rather than materializing 30 days in memory. Cursors expire after 30 minutes and are bound to node/range. Frontend accumulates pages until `next_cursor=null`. Never average percentages. All-failure latency null; failure rate 100. Metadata always included.

## Storage

Independent JSON-versioned ring blocks (v1), not old binary tuples: `network_quality_chunk_10m(node_id,slot,bucket_ts,payload)` 146 slots; `network_quality_5m_chunk_1h` 721 slots. Batches group per block and dedupe sample_id before write. Recompute affected 5m buckets from raw chunks, preserving segment identities. Snapshot/state persisted per node (may use a separate network_quality_state table with JSON); persist only on new accepted data/config state, not every live resource frame. Raw lookback max30m at ingestion; tolerate <=60s future clock skew; ignore older/far-future timestamps. Pure shared fixtures must produce identical Rust/TS queries, hashes, medians and rollups.

No network data to D1. Low-frequency config sync to DO persisted mirror; no D1 reads on steady-state ingestion. New DO schema version migration. Bundle exports settings already; validate network settings on import and remove node overrides on node deletion. TSDB history excluded from Bundle as before.
