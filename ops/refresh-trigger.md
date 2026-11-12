# Quote refresh trigger

This existing file is updated by report jobs to request a fresh quote snapshot without relying on delayed GitHub cron runs.

Last request: 2026-11-12 09:35:00 Asia/Taipei.
Reason: Final pre-send refresh for the 2026-11-12 09:30 early report. Re-run deployed fetch-quotes.mjs commit 56306e7bda3157e386369a0b535b41dd020afded and recalculate every stock's age from the original exchange timestamp at actual Gmail send time. Keep MIS/MCP then Cnyes then timestamp-validated Yahoo order; reject any trade or bid/ask snapshot older than 300 seconds; never relabel bid/ask as a trade.
