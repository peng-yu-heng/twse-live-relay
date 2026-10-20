import { writeFile, mkdir } from 'node:fs/promises';

const STOCKS = [
  {code:'3037', symbol:'3037.TW', name:'欣興', market:'tse'},
  {code:'8046', symbol:'8046.TW', name:'南電', market:'tse'},
  {code:'3189', symbol:'3189.TW', name:'景碩', market:'tse'},
  {code:'1802', symbol:'1802.TW', name:'台玻', market:'tse'},
  {code:'1303', symbol:'1303.TW', name:'南亞', market:'tse'},
  {code:'2408', symbol:'2408.TW', name:'南亞科', market:'tse'},
  {code:'8358', symbol:'8358.TWO', name:'金居', market:'otc'},
  {code:'6147', symbol:'6147.TWO', name:'頎邦', market:'otc'},
];

function taipeiDate(d=new Date()){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
}
function mean(a){ return a.length ? a.reduce((x,y)=>x+y,0)/a.length : null; }
function ma(vals,n){ return vals.length>=n ? mean(vals.slice(-n)) : null; }

function rsiWilder(closes, period){
  if(closes.length < period+1) return null;
  const gains=[], losses=[];
  for(let i=1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    gains.push(Math.max(d,0)); losses.push(Math.max(-d,0));
  }
  let avgGain=mean(gains.slice(0,period));
  let avgLoss=mean(losses.slice(0,period));
  for(let i=period;i<gains.length;i++){
    avgGain=((avgGain*(period-1))+gains[i])/period;
    avgLoss=((avgLoss*(period-1))+losses[i])/period;
  }
  if(avgLoss===0) return 100;
  const rs=avgGain/avgLoss;
  return 100-(100/(1+rs));
}

function kdWilder(rows, period=9){
  if(rows.length < period) return {k:null,d:null,prevK:null,prevD:null,cross:null,kDirection:null,dDirection:null};
  let k=50,d=50,prevK=null,prevD=null,updates=0;
  for(let i=period-1;i<rows.length;i++){
    const window=rows.slice(i-period+1,i+1);
    const high=Math.max(...window.map(r=>r.high));
    const low=Math.min(...window.map(r=>r.low));
    const rsv=high===low?50:100*(rows[i].close-low)/(high-low);
    prevK=k; prevD=d;
    k=(2*k+rsv)/3;
    d=(2*d+k)/3;
    updates++;
  }
  if(updates<2) return {k,d,prevK:null,prevD:null,cross:null,kDirection:null,dDirection:null};
  let cross='none';
  if(prevK<=prevD && k>d) cross='golden_cross';
  else if(prevK>=prevD && k<d) cross='death_cross';
  return {
    k,d,prevK,prevD,cross,
    kDirection:k>prevK?'up':k<prevK?'down':'flat',
    dDirection:d>prevD?'up':d<prevD?'down':'flat'
  };
}

function atrWilder(rows, period=14){
  if(rows.length < period+1) return null;
  const tr=[];
  for(let i=1;i<rows.length;i++){
    const h=rows[i].high,l=rows[i].low,pc=rows[i-1].close;
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  let atr=mean(tr.slice(0,period));
  for(let i=period;i<tr.length;i++) atr=((atr*(period-1))+tr[i])/period;
  return atr;
}

async function fetchYahoo(s){
  const p2=Math.floor(Date.now()/1000);
  const p1=p2-180*86400;
  const u=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.symbol)}?period1=${p1}&period2=${p2}&interval=1d&events=history&includeAdjustedClose=true`;
  const res=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0'}});
  if(!res.ok) throw new Error(`${s.symbol} HTTP ${res.status}`);
  const j=await res.json();
  const r=j?.chart?.result?.[0]; if(!r) throw new Error(`${s.symbol} no result`);
  const q=r.indicators?.quote?.[0], ts=r.timestamp||[];
  const rows=[];
  for(let i=0;i<ts.length;i++){
    const open=q.open?.[i],high=q.high?.[i],low=q.low?.[i],close=q.close?.[i],volume=q.volume?.[i];
    if([open,high,low,close].some(v=>v==null)) continue;
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ts[i]*1000));
    rows.push({date,open,high,low,close,volume:volume??null});
  }
  return rows;
}

await mkdir('analysis',{recursive:true});
const today=taipeiDate();
const out={
  generated_at:new Date().toISOString(),
  indicator_basis:'Completed daily bars only. Unadjusted OHLC. RSI5/10/14 use Wilder smoothing. KD(9,3,3) uses 9-day RSV with K and D initialized at 50 and 1/3 smoothing. ATR14 uses Wilder true range.',
  stocks:[],
  errors:[]
};

for(const s of STOCKS){
  try{
    let rows=await fetchYahoo(s);
    rows=rows.filter(r=>r.date<today);
    const closes=rows.map(r=>r.close);
    const vols=rows.map(r=>r.volume).filter(v=>Number.isFinite(v));
    const last=rows.at(-1);
    const rsi5=rsiWilder(closes,5), rsi5Prev=rsiWilder(closes.slice(0,-1),5);
    const rsi10=rsiWilder(closes,10), rsi10Prev=rsiWilder(closes.slice(0,-1),10);
    const rsi14=rsiWilder(closes,14);
    const rsi14Prev=rsiWilder(closes.slice(0,-1),14);
    const kd=kdWilder(rows,9);
    out.stocks.push({
      ...s,
      last_completed_date:last?.date??null,
      last_completed_close:last?.close??null,
      ma5:ma(closes,5), ma10:ma(closes,10), ma20:ma(closes,20), ma60:ma(closes,60),
      rsi5, rsi5_prev:rsi5Prev, rsi5_change:rsi5!=null&&rsi5Prev!=null?rsi5-rsi5Prev:null,
      rsi10, rsi10_prev:rsi10Prev, rsi10_change:rsi10!=null&&rsi10Prev!=null?rsi10-rsi10Prev:null,
      rsi14, rsi14_prev:rsi14Prev, rsi14_change:rsi14!=null&&rsi14Prev!=null?rsi14-rsi14Prev:null,
      kd_period:'9,3,3', kd_k:kd.k, kd_d:kd.d, kd_prev_k:kd.prevK, kd_prev_d:kd.prevD,
      kd_cross:kd.cross, kd_k_direction:kd.kDirection, kd_d_direction:kd.dDirection,
      atr14:atrWilder(rows,14),
      avg_volume5: vols.length>=5?mean(vols.slice(-5)):null,
      avg_volume20: vols.length>=20?mean(vols.slice(-20)):null,
      high20: rows.length>=20?Math.max(...rows.slice(-20).map(r=>r.high)):null,
      low20: rows.length>=20?Math.min(...rows.slice(-20).map(r=>r.low)):null,
      high60: rows.length>=60?Math.max(...rows.slice(-60).map(r=>r.high)):null,
      low60: rows.length>=60?Math.min(...rows.slice(-60).map(r=>r.low)):null,
      source:'Yahoo Finance chart API (free secondary history source); previous close should be cross-checked against TWSE MIS.'
    });
  }catch(e){ out.errors.push({code:s.code,error:String(e.message||e)}); }
}
await writeFile('analysis/technicals.json',JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify(out,null,2));
if(out.stocks.length<8) process.exitCode=1;
