# Quote refresh trigger

This existing file is updated by report jobs to request a fresh quote snapshot without relying on delayed GitHub cron runs.

Last request: 2026-11-09 09:38 Asia/Taipei.
Reason: immediate send-time refresh for the 09:30 early-session report after report assembly exceeded the five-minute quote window. Run deployed fetch-quotes.mjs, preserve original exchange timestamps, distinguish last trade from bid/ask-only, and reject any symbol older than 300 seconds at publication.
