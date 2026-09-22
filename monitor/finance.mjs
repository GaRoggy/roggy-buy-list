import { MonitorError } from './core.mjs';

export function plaidClient(env, fetcher = fetch) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET || !env.PLAID_ACCESS_TOKEN || env.PLAID_ENV !== 'production') {
    throw new MonitorError('PLAID_PRODUCTION_AUTH_REQUIRED', { terminal: true });
  }
  return async (path, params = {}) => {
    if (!['/transactions/sync','/accounts/get'].includes(path)) throw new MonitorError('FINANCE_ACTION_DENIED',{terminal:true});
    let response;
    try { response = await fetcher(`https://production.plaid.com${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({...params,client_id:env.PLAID_CLIENT_ID,secret:env.PLAID_SECRET,access_token:env.PLAID_ACCESS_TOKEN}) }); }
    catch { throw new MonitorError('NETWORK_ERROR'); }
    const data=await response.json();
    if(!response.ok) {
      const allowed=['TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION','ITEM_LOGIN_REQUIRED','PRODUCT_NOT_READY','RATE_LIMIT_EXCEEDED'];
      const code=allowed.includes(data.error_code)?data.error_code:`HTTP_${response.status}`;
      throw new MonitorError(code,{terminal:code==='ITEM_LOGIN_REQUIRED'||[401,403].includes(response.status),status:response.status});
    }
    return data;
  };
}
export function transaction(t) {
  if(!t.transaction_id || !Number.isFinite(t.amount) || !t.date)throw new MonitorError('INVALID_TRANSACTION');
  const category=t.personal_finance_category?.primary || 'UNKNOWN';
  const detail=t.personal_finance_category?.detailed || 'UNKNOWN';
  const transfer=['TRANSFER_IN','TRANSFER_OUT'].includes(category) || /CREDIT_CARD_PAYMENT/.test(detail);
  return {kind:'transaction',external_id:t.transaction_id,occurred_at:`${t.date}T00:00:00Z`,payload:{
    account_id:t.account_id,date:t.date,authorized_date:t.authorized_date||null,name:t.name,merchant:t.merchant_name||null,
    amount:String(t.amount),currency:t.iso_currency_code||t.unofficial_currency_code||null,pending:!!t.pending,
    pending_transaction_id:t.pending_transaction_id||null,category,category_detail:detail,
    flow:transfer?'transfer':t.amount<0?(category==='INCOME'?'income':'credit'):'expense',
    transfer_reason:transfer?'Provider transfer or credit-card-payment classification':null,
  }};
}
export async function syncFinance(source, api, now=new Date()) {
  let records, cursor;
  for(let restart=0;restart<3;restart++) {
    records=new Map();cursor=source.cursor?.cursor||'';
    try {
      let more;
      do {
        const page=await api('/transactions/sync',{cursor,count:500});
        for(const t of [...(page.added||[]),...(page.modified||[])]) {
          records.set(t.transaction_id,transaction(t));
          if(t.pending_transaction_id)records.set(t.pending_transaction_id,{kind:'transaction',external_id:t.pending_transaction_id,status:'deleted',occurred_at:null,payload:{replaced_by:t.transaction_id}});
        }
        for(const t of page.removed||[])records.set(t.transaction_id,{kind:'transaction',external_id:t.transaction_id,status:'deleted',occurred_at:null,payload:{}});
        if(typeof page.next_cursor!=='string')throw new MonitorError('PLAID_CURSOR_MISSING');
        cursor=page.next_cursor;more=page.has_more;
      }while(more);
      break;
    } catch(e) { if(e.code!=='TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'||restart===2)throw e; }
  }
  const accounts=await api('/accounts/get');
  if(accounts.item?.item_id && accounts.item.item_id!==source.external_id)throw new MonitorError('PLAID_ITEM_MISMATCH',{terminal:true});
  const result=[...records.values()];
  for(const a of accounts.accounts||[]) {
    const payload={account_id:a.account_id,name:a.name,type:a.type,subtype:a.subtype,
      current:a.balances.current==null?null:String(a.balances.current),available:a.balances.available==null?null:String(a.balances.available),
      limit:a.balances.limit==null?null:String(a.balances.limit),currency:a.balances.iso_currency_code||a.balances.unofficial_currency_code||null,
      balance_as_of:a.balances.last_updated_datetime||null,retrieved_at:now.toISOString(),balance_method:'provider_cached'};
    result.push({kind:'financial_account',external_id:a.account_id,occurred_at:now.toISOString(),payload});
    result.push({kind:'balance_snapshot',external_id:`${a.account_id}:${now.toISOString().slice(0,13)}`,occurred_at:now.toISOString(),payload});
  }
  return{records:result,cursor:{cursor}};
}
// Exact decimal addition avoids floating point accumulation and never mixes currencies.
export function sumDecimal(values) {
  const parts=values.map(v=>String(v).split('.'));const scale=Math.max(0,...parts.map(p=>(p[1]||'').length));
  const total=parts.reduce((sum,p)=>sum+BigInt((p[0].startsWith('-')?'-':'')+p[0].replace('-','')+(p[1]||'').padEnd(scale,'0')),0n);
  const sign=total<0n?'-':'', digits=(total<0n?-total:total).toString().padStart(scale+1,'0');
  return sign+(scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits);
}
export function analyzeFinance(records,month,largeThreshold=500) {
  const all=records.filter(r=>r.status!=='deleted'&&!r.payload.pending&&r.payload.currency).map(r=>({...r.payload,id:r.id||r.external_id}));
  const rows=all.filter(t=>t.date.startsWith(month)&&t.flow!=='transfer');
  const currencies={};
  for(const currency of new Set(rows.map(t=>t.currency))) {
    const group=rows.filter(t=>t.currency===currency),categories={};
    for(const c of new Set(group.filter(t=>t.flow==='expense').map(t=>t.category)))categories[c]=sumDecimal(group.filter(t=>t.category===c&&t.flow==='expense').map(t=>t.amount));
    currencies[currency]={spending:sumDecimal(group.filter(t=>t.flow==='expense').map(t=>t.amount)),
      income:sumDecimal(group.filter(t=>t.flow==='income').map(t=>String(-Number(t.amount)))),
      credits:sumDecimal(group.filter(t=>t.flow==='credit').map(t=>String(-Number(t.amount)))),
      net_cash_flow:sumDecimal(group.map(t=>String(-Number(t.amount)))),categories};
  }
  const alerts=[], seen=new Map(),series=new Map();
  for(const t of all.filter(t=>t.flow==='expense')) {
    const key=JSON.stringify([t.account_id,t.merchant||t.name,t.currency,t.amount,t.date]);
    if(seen.has(key))alerts.push({key:`duplicate:${t.id}`,type:'possible_duplicate',severity:'NOTICE',record_ids:[seen.get(key),t.id],reason:'Two posted charges on the same account have the same merchant, date, currency and amount. They may be legitimate separate purchases.'});
    else seen.set(key,t.id);
    if(t.date.startsWith(month)&&Number(t.amount)>=largeThreshold)alerts.push({key:`large:${t.id}`,type:'large_purchase',severity:'NOTICE',record_ids:[t.id],reason:`Posted purchase exceeds the configured ${largeThreshold} ${t.currency} review threshold.`});
    const sk=JSON.stringify([t.account_id,t.merchant||t.name,t.currency]);const list=series.get(sk)||[];list.push(t);series.set(sk,list);
  }
  const recurring=[];
  for(const list of series.values()) {
    list.sort((a,b)=>a.date.localeCompare(b.date));if(list.length<3)continue;
    const last=list.slice(-3), gaps=last.slice(1).map((t,i)=>(Date.parse(t.date)-Date.parse(last[i].date))/86400000);
    if(!gaps.every(d=>d>=25&&d<=35))continue;
    const t=last[2],previous=last[1];
    const next=new Date(t.date+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+Math.round((gaps[0]+gaps[1])/2));
    recurring.push({merchant:t.merchant||t.name,currency:t.currency,last_amount:t.amount,predicted_date:next.toISOString().slice(0,10),
      sample_size:list.length,record_ids:last.map(x=>x.id),confidence:'candidate',reason:'Three posted charges have approximately monthly spacing. This is an estimate, not a confirmed bill.'});
    if(Number(t.amount)!==Number(previous.amount))alerts.push({key:`price:${t.id}`,type:'recurring_price_change',severity:'NOTICE',record_ids:[previous.id,t.id],reason:'The latest charge differs from the previous charge in a candidate monthly series.'});
  }
  return{month,currencies,recurring,alerts,limitations:['Provider-classified transfers and card payments excluded. Unclassified transfers may need review.','Credits are separated from income; savings goals and confirmed bills require explicit source data.']};
}
