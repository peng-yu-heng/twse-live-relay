# Quote refresh trigger

This existing file is updated by report jobs to request a fresh quote snapshot without relying on delayed GitHub cron runs.

Last request: 2026-11-09 09:44 Asia/Taipei.
Reason: correction refresh after Gmail timestamp audit showed the earlier report exceeded the five-minute window by seconds. Run deployed fetch-quotes.mjs, preserve original exchange timestamps, distinguish last trade from bid/ask-only, and reject any symbol older than 300 seconds at corrected publication.
