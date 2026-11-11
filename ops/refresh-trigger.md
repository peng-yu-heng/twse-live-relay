# Quote refresh trigger

This existing file is updated by report jobs to request a fresh quote snapshot without relying on delayed GitHub cron runs.

Last request: 2026-11-11 09:36 Asia/Taipei.
Reason: 09:30 early-report run found quotes/status.json skipped_outside_session and quotes/latest.json still dated 2026-11-10. Run deployed fetch-quotes.mjs commit 56306e7bda3157e386369a0b535b41dd020afded, preserve original exchange timestamps, use MIS/MCP then Cnyes then timestamp-validated Yahoo, downgrade stale trades to fresh bid/ask-only when available, and reject unusable symbols. Refresh is required before any current-price conclusion or Gmail delivery.
