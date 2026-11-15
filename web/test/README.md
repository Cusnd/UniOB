# Network quality checks

Run the pure behavior checks with `npm --prefix web test` (validated on Node 22 and Node 24). They cover failed/null latency, 100% failure rates, round gaps and completion jitter, segment/revision boundaries, full pagination and cancellation, optional snapshot preservation, and network-specific Live/Idle staleness.

For the deterministic browser fixture, run `npm --prefix web run dev -- --host 127.0.0.1 --port 5194` and open `http://127.0.0.1:5194/test/network-quality-ui.html`. This is a development-only HTML entry; it is not linked from or included as an entry in the production application. All responses in this fixture are mocked locally. It mounts the actual network panel, settings component, and server-management editor.

The fixture uses mocked responses. Real Agent → Hub/Worker transport and target reachability require backend integration tests.
