import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectQuotes, normalize, inQuoteWindow, parseRpc, run, GROUPS } from '../scripts/fetch-quotes.mjs';

// Synthetic exchange responses: deterministic regression tests, never production prices.
const AT = new Date('2026-11-03T09:30:00+08:00');
const SYMBOLS = GROUPS.flatMap(g => g.codes.map(code => ({ code, market: g.market })));
const opts = { now: () => AT, wait: async () => {}, random: () => 0 };
const raw = (overrides = {}) => ({ code: '3037', date: '2026-11-03', time: '09:30:00', last: '100', bid: '99', ask: '101', ...overrides });
const mis = (symbols = SYMBOLS, overrides = {}) => new Response(JSON.stringify({ msgArray: symbols.map(s => ({
  c: s.code, ex: s.market, d: '20261103', t: '09:30:00', tlong: String(AT.getTime()), z: '100', b: '99_98_', a: '101_102_', ...overrides,
})) }), { headers: { 'content-type': 'application/json' } });
const relay = (init, overrides = {}) => {
  const req = JSON.parse(init.body), code = req.params.arguments.codes[0];
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { structuredContent: { quotes: [raw({ code, ...overrides })] } } }), { headers: { 'content-type': 'application/json' } });
};

for (const [label, data, mode] of [
  ['fresh trade', {}, 'last_trade'],
  ['fresh one-sided book', { last: '-', bid: '-', ask: '101' }, 'bid_ask_only'],
  ['zero trade', { last: '0', bid: '-', ask: '-' }, 'unusable'],
  ['negative trade', { last: '-1', bid: '-', ask: '-' }, 'unusable'],
  ['future times', { time: '09:30:01' }, 'unusable'],
  ['previous day', { date: '2026-11-02' }, 'unusable'],
  ['missing direct trade time', { _last_trade_time: null }, 'bid_ask_only'],
  ['stale trade fresh book', { _last_trade_time: '09:00:00' }, 'bid_ask_only'],
  ['exactly 300 seconds', { time: '09:25:00' }, 'last_trade'],
  ['301 seconds', { time: '09:24:59' }, 'unusable'],
]) test(`normalization: ${label}`, () => assert.equal(normalize(raw(data), 'tse', new Map(), AT).analysis_mode, mode));

test('carried trade retains its original timestamp and cannot cross dates', () => {
  const prev = new Map([['3037', { date: '2026-11-03', last_trade: 100, last_trade_time: '09:00:00' }]]);
  const q = normalize(raw({ last: '-' }), 'tse', prev, AT);
  assert.equal(q.last_trade_age_seconds, 1800);
  assert.equal(q.analysis_mode, 'bid_ask_only');
  assert.equal(normalize(raw({ last: '-', date: '2026-11-04' }), 'tse', prev, AT).last_trade, null);
});

test('official source succeeds without calling relay', async () => {
  let calls = 0;
  const r = await collectQuotes({ ...opts, fetch: async url => { calls++; assert.equal(new URL(url).hostname, 'mis.twse.com.tw'); return mis(); } });
  assert.equal(calls, 1); assert.equal(r.status.success, true); assert.equal(r.latest.quotes.length, 8);
});

test('temporary official timeout recovers with backoff', async () => {
  let calls = 0; const delays = [];
  const r = await collectQuotes({ ...opts, wait: async ms => delays.push(ms), fetch: async () => {
    if (++calls === 1) throw new Error('timeout'); return mis();
  } });
  assert.equal(calls, 2); assert.equal(r.status.success, true); assert.deepEqual(delays, [500]);
  assert.match(r.status.errors[0], /timeout/);
});

test('official retries request only missing symbols; fallback isolates one bad symbol', async () => {
  let direct = 0; const relayCodes = [];
  const r = await collectQuotes({ ...opts, fetch: async (url, init) => {
    if (new URL(url).hostname === 'mis.twse.com.tw') {
      direct++;
      if (direct > 1) assert.equal(new URL(url).searchParams.get('ex_ch'), 'otc_6147.tw');
      return mis(SYMBOLS.filter(s => s.code !== '6147'));
    }
    relayCodes.push(JSON.parse(init.body).params.arguments.codes[0]); return relay(init);
  } });
  assert.equal(direct, 3); assert.deepEqual(relayCodes, ['6147']); assert.equal(r.status.success, true);
});

test('MCP SSE ignores notifications and assembles multiline response', () => {
  const sse = ': ping\r\n\r\ndata: {"method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: {"id":7,\r\ndata: "result":{"structuredContent":{"quotes":[]}}}\r\n\r\n';
  assert.deepEqual(parseRpc(sse, 'text/event-stream', 7), { structuredContent: { quotes: [] } });
  assert.throws(() => parseRpc('{"id":8,"result":{}}', 'application/json', 7), /matching/);
});

test('freshness is checked again after retries, not at request start', async () => {
  let clock = AT; let calls = 0;
  const r = await collectQuotes({ ...opts, now: () => clock, fetch: async (url, init) => {
    if (new URL(url).hostname === 'mis.twse.com.tw') {
      calls++;
      // One valid symbol at exactly five minutes old; other symbols trigger retries.
      return mis(SYMBOLS.slice(0, 1), { t: '09:25:00', tlong: String(AT.getTime() - 300000) });
    }
    clock = new Date(AT.getTime() + 2000); return relay(init);
  } });
  assert.equal(calls, 3); assert.equal(r.status.success, false);
  assert.ok(r.latest.missing_codes.includes('3037'));
  assert.equal(r.latest.quotes.some(q => q.code === '3037'), false);
  assert.equal(r.latest.complete, false);
});

test('stale/future official timestamps cannot be published; stale fallback remains incomplete', async () => {
  for (const tlong of [String(AT.getTime() + 60000), String(AT.getTime() - 301000), 'invalid']) {
    const r = await collectQuotes({ ...opts, fetch: async (url, init) => new URL(url).hostname === 'mis.twse.com.tw'
      ? mis(SYMBOLS, { tlong }) : relay(init, { date: '2026-11-02' }) });
    assert.equal(r.status.success, false); assert.equal(r.latest.quotes.length, 0);
  }
});

test('relay concurrency is bounded and one failed stock does not discard other stocks', async () => {
  let active = 0, maxActive = 0;
  const r = await collectQuotes({ ...opts, fetch: async (url, init) => {
    if (new URL(url).hostname === 'mis.twse.com.tw') throw new Error('offline');
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    if (JSON.parse(init.body).params.arguments.codes[0] === '3037') return new Response('', { status: 503 });
    return relay(init);
  } });
  assert.ok(maxActive <= 4); assert.ok(maxActive > 1);
  assert.equal(r.status.state, 'partial'); assert.equal(r.latest.quotes.length, 7);
  assert.deepEqual(r.latest.missing_codes, ['3037']);
});

test('outage invalidates old complete snapshot on disk and writes diagnostic status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twse-test-'));
  const root = pathToFileURL(dir + '/');
  try {
    await writeFile(new URL('latest.json', root), JSON.stringify({ complete: true, quotes: [] }));
    const r = await run({ ...opts, root, fetch: async () => { throw new Error('source unavailable'); } });
    assert.equal(r.status.state, 'unavailable');
    const latest = JSON.parse(await readFile(new URL('latest.json', root)));
    assert.equal(latest.complete, false); assert.equal(latest.quotes.length, 0); assert.equal(latest.missing_codes.length, 8);
    assert.equal(JSON.parse(await readFile(new URL('status.json', root))).success, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('off-hours and weekends are explicit skips, with no network or fabricated success', async () => {
  for (const stamp of ['2026-11-03T08:59:59+08:00', '2026-11-03T13:35:01+08:00', '2026-11-03T16:00:00+08:00', '2026-11-07T09:30:00+08:00']) {
    const r = await collectQuotes({ now: () => new Date(stamp), fetch: async () => { assert.fail('must not fetch'); } });
    assert.equal(r.skipped, true); assert.equal(r.status.success, null); assert.equal(r.status.state, 'skipped_outside_session');
  }
  assert.equal(inQuoteWindow(new Date('2026-11-03T09:00:00+08:00')), true);
  assert.equal(inQuoteWindow(new Date('2026-11-03T13:35:00+08:00')), true);
});

test('publishing never replaces newer data with a slow or duplicated older run', async () => {
  const { shouldPublish } = await import('../scripts/should-publish-quotes.mjs');
  const current = { attempted_at: '2026-11-03T09:30:00+08:00' };
  assert.equal(shouldPublish({ attempted_at: '2026-11-03T09:29:00+08:00', completed_at: '2026-11-03T09:32:00+08:00' }, current), false);
  assert.equal(shouldPublish(current, current), false);
  assert.equal(shouldPublish({ attempted_at: '2026-11-03T09:31:00+08:00' }, current), true);
  assert.equal(shouldPublish({ attempted_at: 'invalid' }, current), false);
});

test('off-hours run preserves historical data but explicitly marks status skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twse-test-'));
  const root = pathToFileURL(dir + '/');
  try {
    const old = JSON.stringify({ fetched_at: '2026-11-03T13:30:00+08:00', complete: true, quotes: [] });
    await writeFile(new URL('latest.json', root), old);
    await run({ root, now: () => new Date('2026-11-03T16:00:00+08:00'), fetch: () => assert.fail('must not fetch') });
    assert.equal(await readFile(new URL('latest.json', root), 'utf8'), old);
    assert.equal(JSON.parse(await readFile(new URL('status.json', root))).state, 'skipped_outside_session');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('damaged previous quote structure does not prevent a new successful fetch', async () => {
  const r = await collectQuotes({ ...opts, previous: { quotes: {} }, fetch: async () => mis() });
  assert.equal(r.status.success, true);
});
