# Quote refresh trigger

This existing file is updated by report jobs to request a fresh quote snapshot without relying on delayed GitHub cron runs.

Last request: 2026-11-10 13:11 Asia/Taipei.
Reason: repair refresh after Gmail publication audit found the final 13:09:28 send exceeded five minutes for two last-trade timestamps. Run deployed fetch-quotes.mjs commit 56306e7bda3157e386369a0b535b41dd020afded, preserve original exchange timestamps, downgrade stale trades to fresh bid/ask-only when available, and reject unusable symbols. This is for a clearly labeled correction resend.
