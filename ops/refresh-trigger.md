# Quote refresh trigger

This existing file is updated by report jobs to request a fresh quote snapshot without relying on delayed GitHub cron runs.

Last request: 2026-11-11 09:43 Asia/Taipei.
Reason: final pre-send freshness check for the 2026-11-11 09:30 early report after the first recovery refresh. Run deployed fetch-quotes.mjs commit 56306e7bda3157e386369a0b535b41dd020afded, preserve original exchange timestamps, use MIS/MCP then Cnyes then timestamp-validated Yahoo, downgrade stale trades to fresh bid/ask-only when available, and reject unusable symbols. This is the second and final refresh attempt; Gmail delivery must recompute every stock age from the returned original trade or snapshot time and reject anything over 300 seconds.
