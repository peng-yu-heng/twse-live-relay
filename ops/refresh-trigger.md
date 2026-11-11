# Quote refresh trigger

This existing file is updated by report jobs to request a fresh quote snapshot without relying on delayed GitHub cron runs.

Last request: 2026-11-11 13:10:09 Asia/Taipei.
Reason: final pre-send refresh for the 2026-11-11 13:00 closing report. Run deployed fetch-quotes.mjs commit 56306e7bda3157e386369a0b535b41dd020afded, preserve original exchange timestamps, use MIS/MCP then Cnyes then timestamp-validated Yahoo, validate every stock against the tracking market, and reject any trade or bid/ask snapshot older than 300 seconds. This is the second and final refresh attempt; recompute each stock's age at actual Gmail send time.
