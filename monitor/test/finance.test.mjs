import test from 'node:test';
import assert from 'node:assert/strict';
import { syncFinance, transaction, analyzeFinance, sumDecimal, plaidClient } from '../finance.mjs';
import { MonitorError } from '../core.mjs';
const t=(id,amount,primary='GENERAL_MERCHANDISE')=>({transaction_id:id,account_id:'a',date:'2026-09-21',amount,iso_currency_code:'USD',personal_finance_category:{primary},name:'Merchant'});
test('exact decimal sums and transfer exclusion prevent card-payment double counting',()=>{
  assert.equal(sumDecimal(['0.1','0.2']),'0.3');
  const data=[transaction(t('purchase',30)),transaction(t('payment',30,'TRANSFER_OUT')),transaction(t('income',-100,'INCOME'))];
  const a=analyzeFinance(data,'2026-09');assert.equal(a.currencies.USD.spending,'30');assert.equal(a.currencies.USD.net_cash_flow,'70');
});
test('posted transaction supersedes pending ID and removed entries are tombstoned',async()=>{
  const output=await syncFinance({cursor:{}},async path=>path==='/accounts/get'?{accounts:[]}:{added:[{...t('posted',30),pending_transaction_id:'pending'}],removed:[{transaction_id:'removed'}],next_cursor:'next',has_more:false});
  assert.equal(output.records.find(r=>r.external_id==='pending').status,'deleted');assert.equal(output.cursor.cursor,'next');
});
test('pagination mutation restarts from original cursor and discards partial records',async()=>{
  const cursors=[];let attempt=0;
  const output=await syncFinance({cursor:{cursor:'original'}},async(path,params)=>{
    if(path==='/accounts/get')return{accounts:[]};cursors.push(params.cursor);attempt++;
    if(attempt===1)return{added:[t('discard',1)],next_cursor:'page2',has_more:true};
    if(attempt===2)throw new MonitorError('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
    return{added:[t('keep',2)],next_cursor:'done',has_more:false};
  });
  assert.deepEqual(cursors,['original','page2','original']);assert.deepEqual(output.records.map(r=>r.external_id),['keep']);
});
test('finance adapter rejects money movement endpoints',async()=>{
  const api=plaidClient({PLAID_CLIENT_ID:'test',PLAID_SECRET:'test',PLAID_ACCESS_TOKEN:'test',PLAID_ENV:'production'},async()=>{throw Error('must not call')});
  await assert.rejects(api('/transfer/create'),e=>e.code==='FINANCE_ACTION_DENIED');
});
