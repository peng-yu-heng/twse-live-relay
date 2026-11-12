# Quote refresh trigger

This existing file is updated by report jobs to request a fresh quote snapshot without relying on delayed GitHub cron runs.

Last request: 2026-11-12 09:28:37 Asia/Taipei.
Reason: 2026-11-12 09:30 early-report run found quotes/status unavailable for today and latest still dated 2026-11-11. Run deployed fetch-quotes.mjs commit 56306e7bda3157e386369a0b535b41dd020afded, preserve original exchange timestamps, use MIS/MCP then Cnyes then timestamp-validated Yahoo, validate every stock against the tracking market, and reject any trade or bid/ask snapshot older than 300 seconds. Refresh is required before any current-price conclusion or Gmail delivery.
