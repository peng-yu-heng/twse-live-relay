# Quote refresh trigger

This existing file is updated by report jobs to request a fresh quote snapshot without relying on delayed GitHub cron runs.

Last request: 2026-11-09 09:30 Asia/Taipei.
Reason: 09:30 early-session report refresh. Run deployed fetch-quotes.mjs from commit 56306e7bda3157e386369a0b535b41dd020afded, preserve original exchange timestamps, validate Cnyes fields and market identity, distinguish last trade from bid/ask-only, and reject any symbol older than 300 seconds.
