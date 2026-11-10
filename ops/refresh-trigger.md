# Quote refresh trigger

This existing file is updated by report jobs to request a fresh quote snapshot without relying on delayed GitHub cron runs.

Last request: 2026-11-10 13:08 Asia/Taipei.
Reason: final pre-send freshness refresh for the 13:00 tail-session report. Run deployed fetch-quotes.mjs commit 56306e7bda3157e386369a0b535b41dd020afded, use Cnyes after MIS/MCP and before Yahoo, preserve original exchange trade timestamps, distinguish last trade from bid/ask-only, and reject any symbol older than 300 seconds at Gmail publication.
