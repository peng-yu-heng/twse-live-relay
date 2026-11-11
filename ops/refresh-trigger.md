# Quote refresh trigger

This existing file is updated by report jobs to request a fresh quote snapshot without relying on delayed GitHub cron runs.

Last request: 2026-11-11 13:03:25 Asia/Taipei.
Reason: 13:00 closing-report run found status/latest still from the 09:43 early-report refresh. Run deployed fetch-quotes.mjs commit 56306e7bda3157e386369a0b535b41dd020afded, preserve original exchange timestamps, use MIS/MCP then Cnyes then timestamp-validated Yahoo, validate every stock against the tracking market, and reject any trade or bid/ask snapshot older than 300 seconds. Refresh is required before any current-price conclusion or Gmail delivery.
