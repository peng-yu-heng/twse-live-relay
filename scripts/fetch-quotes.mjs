import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ENDPOINT = 'https://twse-mcp.taux.io/mcp';
const PROTOCOL = '2026-07-28';
const LATEST = new URL('../quotes/latest.json', import.meta.url);
const STATUS = new URL('../quotes/status.json', import.meta.url);

const GROUPS = [
  { market: 'tse', codes: ['3037','8046','3189','1802','1303','2408'] },
  { market: 'otc', codes: ['8358','6147'] },
];

let nextId = 1;

function nowTaipei() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(d);
  const o = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return {
    isoDate: `${o.year}-${o.month}-${o.day}`,
    local: `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}:${o.second}+08:00`,
  };
}

function numericOrNull(v) {
  if (v == null || v === '' || v === '-' || v === '--') return null;
  const n = Number(String(v).replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function rpc(method, params = {}) {
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL,
    'Mcp-Method': method,
  };
  if (typeof params.name === 'string') headers['Mcp-Name'] = params.name;
  const body = {
    jsonrpc: '2.0', id: nextId++, method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0,200)}`);
  const line = res.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').find(l => l.startsWith('data:'))?.slice(5)
    : text;
  if (!line) throw new Error('MCP 回應沒有資料');
  const payload = JSON.parse(line);
  if (payload.error) throw new Error(`JSON-RPC ${payload.error.code}: ${payload.error.message}`);
  return payload.result;
}

function body(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find(c => c.type === 'text')?.text;
  if (!text) throw new Error('工具回應缺 structuredContent/text');
  return JSON.parse(text);
}

async function readPrevious() {
  try { return JSON.parse(await readFile(LATEST, 'utf8')); }
  catch { return { quotes: [] }; }
}

function normalize(q, market, previousByCode, runLocal) {
  const currentLast = numericOrNull(q.last);
  const prev = previousByCode.get(q.code);
  const sameDatePrev = prev && prev.date === q.date ? prev : null;
  const observedLastTime = q._last_trade_time ?? null;
  const carried = currentLast == null && sameDatePrev?.last_trade != null;
  const lastTrade = currentLast ?? (carried ? sameDatePrev.last_trade : null);
  const lastTradeTime = currentLast != null ? (observedLastTime ?? q.time ?? null) : (carried ? sameDatePrev.last_trade_time : null);

  let tradeAgeSeconds = null;
  if (q.date && lastTradeTime) {
    const t = Date.parse(`${q.date}T${lastTradeTime}+08:00`);
    const n = Date.parse(runLocal);
    if (Number.isFinite(t) && Number.isFinite(n)) tradeAgeSeconds = Math.max(0, Math.floor((n - t) / 1000));
  }

  let snapshotAgeSeconds = null;
  if (q.date && q.time) {
    const t = Date.parse(`${q.date}T${q.time}+08:00`);
    const n = Date.parse(runLocal);
    if (Number.isFinite(t) && Number.isFinite(n)) snapshotAgeSeconds = Math.max(0, Math.floor((n - t) / 1000));
  }

  const bid = numericOrNull(q.bid);
  const ask = numericOrNull(q.ask);
  const tradeUsable = q.date === runLocal.slice(0, 10) && tradeAgeSeconds != null && tradeAgeSeconds <= 300;
  const bidAskUsable = q.date === runLocal.slice(0, 10) && snapshotAgeSeconds != null && snapshotAgeSeconds <= 300 && bid != null && ask != null;
  const analysisMode = tradeUsable ? 'last_trade' : bidAskUsable ? 'bid_ask_only' : 'unusable';

  return {
    code: q.code ?? null,
    name: q.name ?? null,
    market,
    date: q.date ?? null,
    snapshot_time: q.time ?? null,
    snapshot_age_seconds: snapshotAgeSeconds,
    last_trade: lastTrade,
    last_trade_time: lastTradeTime,
    last_trade_age_seconds: tradeAgeSeconds,
    carried_forward_last_trade: carried,
    bid,
    ask,
    analysis_mode: analysisMode,
    open: numericOrNull(q.open),
    high: numericOrNull(q.high),
    low: numericOrNull(q.low),
    prev_close: numericOrNull(q.prev_close),
    volume_lots: numericOrNull(q.volume),
    limit_up: numericOrNull(q.limit_up),
    limit_down: numericOrNull(q.limit_down),
  };
}

async function fetchCodes(codes, market, previousByCode, taipei, errors) {
  const latestSnapshotByCode = new Map();
  const lastObservedByCode = new Map();
  const pending = new Set(codes);
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts && pending.size; attempt++) {
    // Query each symbol independently. A 520 for one symbol must not take the whole market batch down.
    for (const code of [...pending]) {
      try {
        const result = await rpc('tools/call', { name: 'quote.realtime', arguments: { codes: [code], market } });
        if (result?.isError) throw new Error(result.content?.map(x => x.text).join(' ') || 'quote.realtime isError');
        const data = body(result);
        const q = (data.quotes ?? []).find(x => x.code === code);
        if (!q) throw new Error('empty quote response');
        latestSnapshotByCode.set(code, q);
        if (numericOrNull(q.last) != null) lastObservedByCode.set(code, { last: q.last, time: q.time ?? null });
        const normalized = normalize(
          lastObservedByCode.has(code) ? { ...q, last: lastObservedByCode.get(code).last, _last_trade_time: lastObservedByCode.get(code).time } : q,
          market, previousByCode, taipei.local
        );
        // A current-date snapshot is enough to stop network retries. Freshness is still enforced later.
        if (normalized.date === taipei.isoDate) pending.delete(code);
        for (const caveat of data.caveats ?? []) errors.push(`[${market}:${code}] caveat: ${caveat}`);
      } catch (e) {
        errors.push(`[${market}:${code}] attempt ${attempt}/${maxAttempts}: ${e?.message ?? String(e)}`);
      }
      await sleep(250);
    }
    if (pending.size && attempt < maxAttempts) await sleep(Math.min(15000, 1500 * 2 ** (attempt - 1)));
  }

  return codes.map(code => {
    const snapshot = latestSnapshotByCode.get(code);
    if (!snapshot) return null;
    const observed = lastObservedByCode.get(code);
    return normalize(observed ? { ...snapshot, last: observed.last, _last_trade_time: observed.time } : snapshot, market, previousByCode, taipei.local);
  }).filter(Boolean);
}

async function main() {
  await mkdir(new URL('../quotes/', import.meta.url), { recursive: true });
  const prev = await readPrevious();
  const previousByCode = new Map((prev.quotes ?? []).map(q => [q.code, q]));
  const taipei = nowTaipei();
  const collected = [];
  const errors = [];

  for (const g of GROUPS) {
    const rows = await fetchCodes(g.codes, g.market, previousByCode, taipei, errors);
    collected.push(...rows);
  }

  const byCode = new Map(collected.map(q => [q.code, q]));
  const expected = GROUPS.flatMap(g => g.codes);
  const missing = expected.filter(c => !byCode.has(c));
  const staleDate = collected.filter(q => q.date !== taipei.isoDate).map(q => q.code);
  const fresh = collected.filter(q => q.analysis_mode === 'last_trade').map(q => q.code);
  const bidAskOnly = collected.filter(q => q.analysis_mode === 'bid_ask_only').map(q => q.code);
  const unusable = collected.filter(q => q.analysis_mode === 'unusable').map(q => q.code);

  const status = {
    attempted_at: taipei.local,
    source: 'TWSE MIS via taux-io/twse-mcp Cloudflare relay; per-symbol retry isolation',
    endpoint: ENDPOINT,
    expected_codes: expected,
    received_codes: collected.map(q => q.code),
    fresh_trade_codes_le_5m: fresh,
    fresh_bid_ask_only_codes_le_5m: bidAskOnly,
    unusable_codes: unusable,
    missing_codes: missing,
    stale_date_codes: staleDate,
    errors,
    success: missing.length === 0 && staleDate.length === 0 && unusable.length === 0 && errors.filter(x => !x.includes('caveat:')).length === 0,
  };

  await writeFile(STATUS, JSON.stringify(status, null, 2) + '\n');

  if (collected.length) {
    const latest = {
      fetched_at: taipei.local,
      trading_date: taipei.isoDate,
      source: 'TWSE MIS (mis.twse.com.tw) via taux-io/twse-mcp',
      freshness_rule: 'Use last_trade only when last_trade_age_seconds <= 300. If last_trade is unavailable but bid/ask snapshot_age_seconds <= 300, use analysis_mode=bid_ask_only and never label bid/ask as a trade price.',
      quotes: expected.map(c => byCode.get(c)).filter(Boolean),
      errors,
    };
    await writeFile(LATEST, JSON.stringify(latest, null, 2) + '\n');
  }

  console.log(JSON.stringify(status, null, 2));
  if (!collected.length) process.exitCode = 1;
}

main().catch(async (e) => {
  const taipei = nowTaipei();
  const status = { attempted_at: taipei.local, success: false, errors: [e?.stack ?? String(e)] };
  await mkdir(new URL('../quotes/', import.meta.url), { recursive: true });
  await writeFile(STATUS, JSON.stringify(status, null, 2) + '\n');
  console.error(e);
  process.exit(1);
});
// report-refresh-trigger: 2026-10-01T11:43+08:00
// report-final-refresh: 2026-10-01T11:47+08:00
