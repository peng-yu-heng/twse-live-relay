# TWSE Live Relay

Free relay for the eight tracked Taiwan stocks. It calls the public `taux-io/twse-mcp` remote MCP, whose real-time quote tool proxies TWSE MIS (`mis.twse.com.tw`), and writes normalized JSON into `quotes/latest.json`.

Tracked codes:
- TSE: 3037, 8046, 3189, 1802, 1303, 2408
- OTC: 8358, 6147

Safety rules:
- Quote date must equal the current Taiwan trading date.
- A trade price is actionable only when `last_trade_age_seconds <= 300`.
- Bid/ask are never substituted as the last trade price.
- If the source fails, `quotes/status.json` records the failure; no fabricated quote is created.

GitHub Actions runs shortly before and after the 09:30 and 13:00 report windows (Asia/Taipei). Scheduled Actions can be delayed, so the consumer must still enforce the 5-minute freshness rule.
