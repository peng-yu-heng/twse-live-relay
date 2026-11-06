# Quote refresh trigger

This existing file is updated by report jobs to request a fresh quote snapshot without relying on delayed GitHub cron runs.

Last request: 2026-11-06 13:07 Asia/Taipei.
Reason: final pre-send refresh for the 13:00 tail report. Re-run deployed fetch-quotes.mjs, preserve original exchange timestamps, distinguish last trade from bid/ask-only, and reject any symbol older than 300 seconds.
