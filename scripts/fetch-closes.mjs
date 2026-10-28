import {mkdir,readFile,writeFile} from 'node:fs/promises';
const ROOT=new URL('../quotes/',import.meta.url);
const STOCKS=[['3037','欣興','tse'],['8046','南電','tse'],['3189','景碩','tse'],['1802','台玻','tse'],['1303','南亞','tse'],['2408','南亞科','tse'],['8358','金居','otc'],['6147','頎邦','otc']].map(([code,name,market])=>({code,name,market}));
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function numeric(v){if(v==null||/^\s*(?:-|--|N\/A|－)?\s*$/.test(String(v)))return null;const n=Number(String(v).replaceAll(',','').trim());return Number.isFinite(n)?n:null;}
function parseDate(v){const s=String(v??'').trim();if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;if(/^\d{4}\/\d{2}\/\d{2}$/.test(s))return s.replaceAll('/','-');const m=s.match(/^(\d{2,3})[/-]?(\d{2})[/-]?(\d{2})$/);return m?String(Number(m[1])+1911)+'-'+m[2]+'-'+m[3]:null;}
function parseCsv(body){
  const lines=[];let row=[],value='',quoted=false;
  for(let i=0;i<body.length;i++){const c=body[i];
    if(c==='"'){if(quoted&&body[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){row.push(value);value='';}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&body[i+1]==='\n')i++;row.push(value);if(row.some(x=>x.trim()))lines.push(row);row=[];value='';}
    else value+=c;
  }
  if(value||row.length){row.push(value);lines.push(row);}
  return lines;
}
async function getJson(url){
  const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0','accept':'application/json,text/csv,*/*'},signal:AbortSignal.timeout(14000)});
  if(!r.ok)throw Error('HTTP '+r.status);
  const body=await r.text();
  try{return JSON.parse(body);}catch(e){
    const csv=parseCsv(body);
    if(csv.length>1&&csv[0].some(x=>x.includes('日期'))&&csv[0].some(x=>x.includes('證券代號')))return {_csvRows:csv};
    throw Error('unexpected format: '+body.slice(0,90).replace(/\s+/g,' '));
  }
}
function validate(row,date){const close=numeric(row.close),open=numeric(row.open),high=numeric(row.high),low=numeric(row.low),volume=numeric(row.volume_shares);if(row.date!==date)throw Error(row.code+': wrong trade date '+row.date);if(!(close>0))throw Error(row.code+': no valid official close');if([open,high,low].every(x=>x!==null)&&!(low<=open&&open<=high&&low<=close&&close<=high))throw Error(row.code+': invalid OHLC');if(volume!==null&&volume<0)throw Error(row.code+': invalid volume');return {...row,close,open,high,low,volume_shares:volume};}
function twseOpen(j,date){if(!Array.isArray(j))throw Error('TWSE OpenAPI not array');return STOCKS.filter(s=>s.market==='tse').flatMap(s=>{const r=j.find(x=>String(x.Code??'').trim()===s.code);return r?[validate({...s,date:parseDate(r.Date),close:r.ClosingPrice,open:r.OpeningPrice,high:r.HighestPrice,low:r.LowestPrice,volume_shares:r.TradeVolume,source:'TWSE OpenAPI STOCK_DAY_ALL'},date)]:[];});}
function twseRwd(j,date){
  if(Array.isArray(j._csvRows)){
    const rows=j._csvRows;
    return STOCKS.filter(s=>s.market==='tse').flatMap(s=>{
      const r=rows.find(x=>Array.isArray(x)&&String(x[1]).trim()===s.code);
      if(!r)return [];
      const d=parseDate(r[0]);
      return [validate({...s,date:d,close:r[8],open:r[5],high:r[6],low:r[7],volume_shares:r[3],source:'TWSE RWD dated CSV STOCK_DAY_ALL'},date)];
    });
  }
  if(!Array.isArray(j.data))throw Error('TWSE RWD no data');
  const d=parseDate(j.date??j.reportDate??'');
  if(d!==date)throw Error('TWSE RWD report date '+d);
  return STOCKS.filter(s=>s.market==='tse').flatMap(s=>{
    const r=j.data.find(x=>Array.isArray(x)&&String(x[0]).trim()===s.code);
    return r?[validate({...s,date,close:r[7],open:r[4],high:r[5],low:r[6],volume_shares:r[2],source:'TWSE RWD STOCK_DAY_ALL'},date)]:[];
  });
}
function tpexOpen(j,date){if(!Array.isArray(j))throw Error('TPEx OpenAPI not array');return STOCKS.filter(s=>s.market==='otc').flatMap(s=>{const r=j.find(x=>String(x.SecuritiesCompanyCode??x.Code??'').trim()===s.code);return r?[validate({...s,date:parseDate(r.Date),close:r.Close,open:r.Open,high:r.High,low:r.Low,volume_shares:r.TradingShares,source:'TPEx OpenAPI daily_close_quotes'},date)]:[];});}
function tpexLegacy(j,date){const d=parseDate(j.reportDate??j.date??j.d??'');if(d!==date)throw Error('TPEx legacy report date unavailable '+d);const candidates=[j.aaData,...(j.tables??[]).map(t=>t.data)].filter(Array.isArray);return STOCKS.filter(s=>s.market==='otc').flatMap(s=>{const r=candidates.flat().find(x=>Array.isArray(x)&&String(x[0]).trim()===s.code);return r?[validate({...s,date,close:r[2],open:null,high:null,low:null,volume_shares:null,source:'TPEx legacy verified-date daily quotes, close only'},date)]:[];});}
const date=process.env.TARGET_DATE??today();if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>today())throw Error('invalid/future TARGET_DATE');
const ymd=date.replaceAll('-',''),roc=String(Number(date.slice(0,4))-1911)+'/'+date.slice(5,7)+'/'+date.slice(8,10);
const providers=[
{url:'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',market:'tse',parse:twseOpen},
{url:'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json&date='+ymd,market:'tse',parse:twseRwd},
{url:'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',market:'otc',parse:tpexOpen},
{url:'https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&d='+encodeURIComponent(roc)+'&o=json',market:'otc',parse:tpexLegacy},
];
const found=new Map(),errors=[];
for(const p of providers){if(STOCKS.filter(s=>s.market===p.market).every(s=>found.has(s.code)))continue;try{const rows=p.parse(await getJson(p.url),date);for(const r of rows)if(!found.has(r.code))found.set(r.code,r);if(!rows.length)errors.push(p.url+': no requested symbols');}catch(e){errors.push(p.url+': '+e.message);}}
const verified=STOCKS.filter(s=>found.has(s.code)).map(s=>found.get(s.code)),missing=STOCKS.filter(s=>!found.has(s.code)).map(s=>s.code),collected_at=new Date().toISOString();
const status={attempted_at:collected_at,trading_date:date,expected_codes:STOCKS.map(s=>s.code),verified_codes:verified.map(s=>s.code),missing_codes:missing,success:missing.length===0,errors};
await mkdir(ROOT,{recursive:true});await writeFile(new URL('close-status.json',ROOT),JSON.stringify(status,null,2)+'\n');
if(verified.length){const snapshot={trading_date:date,collected_at,price_type:'official_daily_close',complete:missing.length===0,verified_codes:verified.map(s=>s.code),quotes:verified,errors};await writeFile(new URL('close-'+date+'.json',ROOT),JSON.stringify(snapshot,null,2)+'\n');if(!missing.length){let old='';try{old=JSON.parse(await readFile(new URL('close-latest.json',ROOT),'utf8')).trading_date??'';}catch{}if(date>=old)await writeFile(new URL('close-latest.json',ROOT),JSON.stringify(snapshot,null,2)+'\n');}}
console.log(JSON.stringify(status,null,2));if(missing.length){console.error('OFFICIAL_CLOSE_INCOMPLETE: never substitute live bid/ask for official close');process.exitCode=1;}
