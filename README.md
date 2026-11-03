# TWSE Live Relay

Free relay for eight tracked Taiwan stocks. It fetches TWSE MIS (`mis.twse.com.tw`) directly, then uses the public `taux-io/twse-mcp` remote MCP for unresolved symbols, and writes normalized JSON into `quotes/latest.json`.

Tracked codes:
- TSE: 3037, 8046, 3189, 1802, 1303, 2408
- OTC: 8358, 6147

Safety rules:
- Quote date must equal the current Taiwan trading date.
- A trade price is actionable only when `last_trade_age_seconds <= 300`.
- If no fresh trade price is available but bid/ask are fresh (`snapshot_age_seconds <= 300`), the relay marks the row `analysis_mode=bid_ask_only`.
- Bid/ask are never substituted or labeled as the last trade price.
- If neither a fresh trade nor fresh bid/ask is available, the row is `analysis_mode=unusable`.
- If the source fails, `quotes/status.json` records the failure; no fabricated quote is created.

GitHub Actions runs shortly before and after the 09:30 and 13:00 report windows (Asia/Taipei). Scheduled Actions can be delayed, so the consumer must still enforce the 5-minute freshness rule.

## Local development and reliability

Use Node.js 22 (matching CI). There are no npm dependencies. Run the deterministic
regression tests with `node --test tests/*.test.mjs`. Tests use synthetic responses;
they do not access the exchange or write production quote files.

Run `node scripts/fetch-quotes.mjs` to refresh live JSON. Direct MIS requests retry
only unresolved stocks up to three times with exponential backoff and jitter.
The MCP fallback retries each remaining symbol twice, with at most four concurrent
requests. All requests have timeouts. Freshness is recalculated after fetching,
just before writing the files; future timestamps and nonpositive prices are rejected.
JSON files are replaced atomically, individually. Read status and snapshot timestamps
together if consuming both files: they are not a single atomic transaction.

`quotes/status.json` now reports `state`:

- `ok`: all eight stocks have usable data; `success=true`.
- `partial` or `unavailable`: missing, stale or invalid stocks; `success=false`, exit 1.
  `latest.json` is replaced even on total failure (`complete=false`, empty quotes),
  so an earlier complete snapshot cannot masquerade as the latest successful run.
  `missing_codes` includes every stock with no publishable row.
- `skipped_outside_session`: weekday time outside 09:00–13:35 Asia/Taipei or a
  weekend; `success=null`, exit 0, no network requests. Historical `latest.json`
  is retained. This is not a successful live quote. Exchange holidays are not
  guessed: a weekday closure can still report unavailable data.

Consumers must recalculate freshness from each row's exchange `date` and
`last_trade_time`/`snapshot_time` at the time of use. Stored age fields and
`complete=true` describe generation time only. Do not interpret a skipped run,
a historical snapshot, or a fresh HTTP response as proof of a fresh trade.

Scheduled live fetches stop at 13:32. New runs cancel older queued/running fetches,
and publication checks request timestamps to prevent older runs from overwriting
newer results. GitHub Actions schedules remain best-effort; they cannot guarantee
an exact reporting minute or continuous five-minute availability. This relay still
depends on public MIS and its MCP proxy (which shares the underlying exchange source).

For proxy-based cloud environments, activate `NODE_USE_ENV_PROXY=1` with a recent
Node.js 22 release, keep the inherited proxy and CA settings, and allow HTTPS to
`mis.twse.com.tw` and `twse-mcp.taux.io`. A proxy policy denial needs an environment
setting change; retries cannot resolve it.
