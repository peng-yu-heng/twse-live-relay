import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function shouldPublish(incoming, current) {
  // Compare request start, not completion: a slow old request must not win a race.
  const next = Date.parse(incoming.attempted_at);
  const previous = Date.parse(current.attempted_at);
  return Number.isFinite(next) && (!Number.isFinite(previous) || next > previous);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const incoming = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const current = JSON.parse(await readFile(process.argv[3], 'utf8'));
    if (!Number.isFinite(Date.parse(incoming.attempted_at))) throw new Error('Incoming status has no valid attempted_at');
    process.exitCode = shouldPublish(incoming, current) ? 0 : 1;
  } catch (e) {
    console.error('Cannot verify quote publication order:', e.message);
    process.exitCode = 2; // Distinguish corrupt/missing files from a superseded run.
  }
}
