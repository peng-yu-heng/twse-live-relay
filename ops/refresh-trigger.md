# Quote refresh trigger

This existing file is updated by report jobs to request a fresh quote snapshot without relying on delayed GitHub cron runs.

Last request: 2026-11-06 13:00 Asia/Taipei.
Reason: 13:00 tail report pre-analysis refresh; previous latest/status were from 09:38 and stale. Run deployed fetch-quotes.mjs with Cnyes before Yahoo, preserve original exchange TRADE_TIME, and reject any symbol older than 300 seconds.
