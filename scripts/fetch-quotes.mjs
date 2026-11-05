import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ENDPOINT = 'https://twse-mcp.taux.io/mcp';
const PROTOCOL = '2026-07-28';
const ROOT = new URL('../quotes/', import.meta.url);
export const GROUPS = [
  { market: 'tse', codes: ['3037','8046','3189','1802','1303','2408'] },
  { market: 'otc', codes: ['8358','6147'] },
];
const EXPECTED = GROUPS.flatMap(g => g.codes);
const SOURCE = 'TWSE MIS direct; MCP per-symbol fallback; independent Yahoo Finance timestamp-validated fallback';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function nowTaipei(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const o = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { isoDate: `${o.year}-${o.month}-${o.day}`, local: `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}:${o.second}+08:00` };
}

export function inQuoteWindow(date) {
  const local = nowTaipei(date).local;
  const weekday = new Date(`${local.slice(0, 10)}T00:00:00Z`).getUTCDay();
  const time = local.slice(11, 19);
  // Include the five-minute freshness allowance after the 13:30 closing auction.
  // Exchange holidays are not inferred from network errors or an empty response.
  return weekday !== 0 && weekday !== 6 && time >= '09:00:00' && time <= '13:35:00';
}

function numericOrNull(v) {
  if (v == null || String(v).trim() === '' || /^-+$/.test(String(v).trim())) return null;
  const n = Number(String(v).replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}
const price = v => { const n = numericOrNull(v); return n > 0 ? n : null; };

function age(date, time, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d{2}:\d{2}:\d{2}$/.test(time ?? '')) return null;
  const stamp = Date.parse(`${date}T${time}+08:00`);
  const seconds = Math.floor((now.getTime() - stamp) / 1000);
  // Never turn a future timestamp into a fresh quote by clamping its age to zero.
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function normalize(q, market, previousByCode, now) {
  const current = price(q.last);
  const prev = previousByCode.get(q.code);
  const carried = current == null && prev?.date === q.date && price(prev.last_trade) != null;
  const last = current ?? (carried ? price(prev.last_trade) : null);
  // Direct MIS must supply the actual trade time separately from its snapshot time.
  const tradeTime = current != null
    ? (Object.hasOwn(q, '_last_trade_time') ? q._last_trade_time : q.time) ?? null
    : carried ? prev.last_trade_time : null;
  const tradeAge = age(q.date, tradeTime, now);
  const snapshotAge = age(q.date, q.time, now);
  const bid = price(q.bid), ask = price(q.ask);
  const sameDate = q.date === nowTaipei(now).isoDate;
  const freshTrade = sameDate && last != null && tradeAge != null && tradeAge <= 300;
  const freshBook = sameDate && snapshotAge != null && snapshotAge <= 300 && (bid != null || ask != null);
  return {
    code: q.code, name: q.name ?? null, market, date: q.date ?? null,
    snapshot_time: q.time ?? null, snapshot_age_seconds: snapshotAge,
    last_trade: last, last_trade_time: tradeTime, last_trade_age_seconds: tradeAge,
    carried_forward_last_trade: carried, bid, ask,
    analysis_mode: freshTrade ? 'last_trade' : freshBook ? 'bid_ask_only' : 'unusable',
    open: numericOrNull(q.open), high: numericOrNull(q.high), low: numericOrNull(q.low),
    prev_close: numericOrNull(q.prev_close), volume_lots: numericOrNull(q.volume),
    limit_up: numericOrNull(q.limit_up), limit_down: numericOrNull(q.limit_down),
    quote_source: q.quote_source,
  };
}


export function yahooQuote(data, code, market, now) {
  const symbol = code + (market === 'otc' ? '.TWO' : '.TW');
  const result = data?.chart?.result?.[0], m = result?.meta;
  if (data?.chart?.error || !m || m.symbol !== symbol || m.currency !== 'TWD'
      || m.exchangeTimezoneName !== 'Asia/Taipei'
      || m.exchangeName !== (market === 'otc' ? 'TWO' : 'TAI')
      || !Number.isFinite(m.regularMarketTime) || m.regularMarketTime < 1e9) {
    throw new Error('Yahoo symbol, exchange, currency or timestamp mismatch');
  }
  const stamp = nowTaipei(new Date(m.regularMarketTime * 1000));
  const times = result.timestamp ?? [], opens = result.indicators?.quote?.[0]?.open ?? [];
  const start = m.currentTradingPeriod?.regular?.start;
  const first = times.findIndex((t, i) => t >= start && price(opens[i]) != null);
  const q = { code, name: m.shortName ?? m.longName, date: stamp.isoDate, time: stamp.local.slice(11, 19),
    _last_trade_time: stamp.local.slice(11, 19), last: m.regularMarketPrice, bid: null, ask: null,
    open: first >= 0 ? opens[first] : null, high: m.regularMarketDayHigh, low: m.regularMarketDayLow,
    prev_close: m.chartPreviousClose ?? m.previousClose,
    volume: numericOrNull(m.regularMarketVolume) == null ? null : Number(m.regularMarketVolume) / 1000,
    quote_source: 'Yahoo Finance chart meta regularMarketTime (secondary independent feed)' };
  if (normalize(q, market, new Map(), now).analysis_mode !== 'last_trade') {
    throw new Error('Yahoo trade missing, future, prior date or older than five minutes');
  }
  return q;
}

export function parseRpc(text, contentType, id) {
  const messages = contentType?.includes('text/event-stream')
    ? text.replaceAll('\r\n', '\n').split(/\n\n/).map(event => event.split('\n')
      .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean)
    : [text];
  for (const message of messages) {
    const payload = JSON.parse(message);
    if (payload.id !== id) continue; // Ignore notifications before the response.
    if (payload.error) throw new Error(`JSON-RPC ${payload.error.code}: ${payload.error.message}`);
    if (!payload.result) throw new Error('MCP response missing result');
    return payload.result;
  }
  throw new Error('MCP response missing matching request ID');
}

function resultBody(result) {
  if (result?.isError) throw new Error(result.content?.map(x => x.text).join(' ') || 'quote.realtime isError');
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find(c => c.type === 'text')?.text;
  if (!text) throw new Error('MCP response missing structuredContent/text');
  return JSON.parse(text);
}

function errorMessage(e) {
  return [e?.message ?? String(e), e?.cause?.message].filter(Boolean).join(': ');
}

export async function collectQuotes({ fetch: request = globalThis.fetch, now = () => new Date(), wait = sleep, random = Math.random, previous = { quotes: [] } } = {}) {
  const started = now();
  const startedLocal = nowTaipei(started);
  const base = { attempted_at: startedLocal.local, source: SOURCE, endpoint: ENDPOINT, expected_codes: EXPECTED };
  if (!inQuoteWindow(started)) {
    return { skipped: true, status: { ...base, state: 'skipped_outside_session', success: null,
      reason: 'Outside weekday 09:00–13:35 Asia/Taipei quote window; no live quote attempted.', errors: [] } };
  }
  const previousByCode = new Map((Array.isArray(previous?.quotes) ? previous.quotes : []).filter(q => q && typeof q.code === 'string').map(q => [q.code, q]));
  const errors = [], found = new Map();
  const usable = (q, market) => normalize(q, market, previousByCode, now()).analysis_mode !== 'unusable';
  const backoff = attempt => wait(500 * 2 ** (attempt - 1) + Math.floor(random() * 250));
  let nextId = 1;

  // Retry only unresolved symbols. A malformed or missing row must not discard its peers.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pending = GROUPS.flatMap(g => g.codes.filter(code => !found.has(code) || !usable(found.get(code), g.market)).map(code => ({ code, market: g.market })));
    if (!pending.length) break;
    try {
      const url = new URL('https://mis.twse.com.tw/stock/api/getStockInfo.jsp');
      url.searchParams.set('ex_ch', pending.map(s => `${s.market}_${s.code}.tw`).join('|'));
      url.searchParams.set('json', '1'); url.searchParams.set('delay', '0');
      url.searchParams.set('_', String(now().getTime()));
      const response = await request(url, {
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0', 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`MIS HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.msgArray)) throw new Error('MIS response missing msgArray');
      for (const x of data.msgArray) {
        const symbol = pending.find(s => s.code === String(x.c) && s.market === x.ex);
        if (!symbol) continue;
        const date = String(x.d ?? '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
        const epoch = Number(x.tlong);
        if (!Number.isFinite(epoch) || epoch < 1e12) { errors.push(`[direct-MIS:${symbol.code}] missing exchange tlong`); continue; }
        const snapshot = nowTaipei(new Date(epoch));
        const snapshotAge = age(date, snapshot.local.slice(11, 19), now());
        if (snapshot.isoDate !== date || date !== nowTaipei(now()).isoDate || snapshotAge == null || snapshotAge > 300) {
          errors.push(`[direct-MIS:${symbol.code}] stale/invalid exchange timestamp`); continue;
        }
        const first = value => String(value ?? '').split('_')[0];
        const q = { code: symbol.code, name: x.n, date, time: snapshot.local.slice(11, 19),
          last: x.z, _last_trade_time: x.t ?? null, bid: first(x.b), ask: first(x.a),
          open: x.o, high: x.h, low: x.l, prev_close: x.y, volume: x.v, limit_up: x.u, limit_down: x.w,
          quote_source: 'TWSE MIS direct (exchange tlong validated)' };
        if (usable(q, symbol.market)) found.set(symbol.code, q);
      }
    } catch (e) { errors.push(`[direct-MIS] attempt ${attempt}/3: ${errorMessage(e)}`); }
    const unresolved = pending.filter(s => !found.has(s.code) || !usable(found.get(s.code), s.market));
    if (!unresolved.length) break;
    errors.push(`[direct-MIS] attempt ${attempt}/3 unresolved: ${unresolved.map(s => s.code).join(',')}`);
    if (attempt < 3) await backoff(attempt);
  }

  const unresolved = GROUPS.flatMap(g => g.codes.filter(code => !found.has(code) || !usable(found.get(code), g.market)).map(code => ({ code, market: g.market })));
  // Limit relay concurrency to avoid a burst of eight requests against one upstream.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, unresolved.length) }, async () => {
    while (cursor < unresolved.length) {
      const { code, market } = unresolved[cursor++];
      let observed = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const id = nextId++;
          const res = await request(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
              'MCP-Protocol-Version': PROTOCOL, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'quote.realtime' },
            body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
              name: 'quote.realtime', arguments: { codes: [code], market },
              _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {} },
            } }), signal: AbortSignal.timeout(6500),
          });
          if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
          const data = resultBody(parseRpc(await res.text(), res.headers.get('content-type'), id));
          const q = data.quotes?.find(row => String(row.code) === code);
          if (!q) throw new Error('empty quote response');
          // Carry a trade only within the same exchange date, retaining its original time.
          if (price(q.last) != null) observed = { date: q.date, last: q.last, time: q.time };
          const row = { ...q, code, quote_source: 'taux-io/twse-mcp relay' };
          if (price(q.last) == null && observed?.date === q.date) {
            row.last = observed.last; row._last_trade_time = observed.time;
          }
          found.set(code, row);
          if (usable(row, market)) break;
          throw new Error('stale, invalid or unusable quote');
        } catch (e) { errors.push(`[${market}:${code}] attempt ${attempt}/2: ${errorMessage(e)}`); }
        if (attempt < 2) await backoff(attempt);
      }
    }
  }));


  // A separate provider is necessary: MIS and the MCP relay share one upstream.
  const yahooPending = GROUPS.flatMap(g => g.codes
    .filter(code => !found.has(code) || !usable(found.get(code), g.market))
    .map(code => ({ code, market: g.market })));
  let yahooCursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, yahooPending.length) }, async () => {
    while (yahooCursor < yahooPending.length) {
      const { code, market } = yahooPending[yahooCursor++];
      try {
        const symbol = code + (market === 'otc' ? '.TWO' : '.TW');
        const url = new URL('https://query1.finance.yahoo.com/v8/finance/chart/' + symbol);
        url.searchParams.set('interval', '1m'); url.searchParams.set('range', '1d');
        const res = await request(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
        found.set(code, yahooQuote(await res.json(), code, market, now()));
      } catch (e) { errors.push('[yahoo:' + code + '] ' + errorMessage(e)); }
    }
  }));

  // Recompute every age at publication, after all timeouts, retries and relay calls.
  const finished = now(), taipei = nowTaipei(finished);
  const collected = GROUPS.flatMap(g => g.codes.filter(code => found.has(code)).map(code => normalize(found.get(code), g.market, previousByCode, finished)));
  const publishable = collected.filter(q => q.analysis_mode !== 'unusable');
  const missing = EXPECTED.filter(code => !publishable.some(q => q.code === code));
  const success = missing.length === 0;
  const status = { ...base, completed_at: taipei.local, state: success ? 'ok' : publishable.length ? 'partial' : 'unavailable',
    received_codes: collected.map(q => q.code), fresh_trade_codes_le_5m: collected.filter(q => q.analysis_mode === 'last_trade').map(q => q.code),
    fresh_bid_ask_only_codes_le_5m: collected.filter(q => q.analysis_mode === 'bid_ask_only').map(q => q.code),
    unusable_codes: collected.filter(q => q.analysis_mode === 'unusable').map(q => q.code), missing_codes: missing,
    stale_date_codes: collected.filter(q => q.date !== taipei.isoDate).map(q => q.code), errors, success };
  const latest = { fetched_at: taipei.local, trading_date: taipei.isoDate, source: SOURCE,
    freshness_rule: 'Recalculate age from exchange date/time at use. Use last_trade only with positive price and age 0..300s; bid/ask only with snapshot age 0..300s. Never relabel bid/ask as a trade.',
    complete: success, missing_codes: missing, quotes: publishable, errors };
  return { status, latest, skipped: false };
}

async function atomicJson(url, value) {
  const temp = new URL(`${url.href}.${process.pid}.tmp`);
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n');
  await rename(temp, url);
}

export async function run({ root = ROOT, ...options } = {}) {
  await mkdir(root, { recursive: true });
  let previous = { quotes: [] };
  try { previous = JSON.parse(await readFile(new URL('latest.json', root), 'utf8')); } catch { /* First run or damaged snapshot. */ }
  const result = await collectQuotes({ ...options, previous });
  // Write even an empty failed snapshot: an old complete=true must not survive an outage.
  if (result.latest) await atomicJson(new URL('latest.json', root), result.latest);
  await atomicJson(new URL('status.json', root), result.status);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(({ status, skipped }) => {
    console.log(JSON.stringify(status, null, 2));
    if (!skipped && !status.success) {
      console.error('LIVE_QUOTE_VALIDATION_FAILED: missing, stale or unusable quotes. See quotes/status.json.');
      process.exitCode = 1;
    }
  }).catch(e => { console.error(e); process.exitCode = 1; });
}
