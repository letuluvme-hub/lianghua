import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArguments, createRestEnvironment, runImportCommand } from '../scripts/subscription-import.mjs';
import { createD1, createKV } from './helpers/d1-sqlite.mjs';

const flags=['--apply','--handover-confirmed','--dispatch-drained'];
const id='offline-import';
const account='a'.repeat(32), namespace='cd3da0fe397f42f288c6a29cd06c11b5', db='00000000-0000-4000-8000-000000000001';
const token='fake-never-print-this';
const record=(email,extras={})=>({email,stocks:['600036'],period:20,sendTime:'16:00',timezone:'Asia/Shanghai',lastSentDate:'2026-09-30',...extras});
const config=(mode='handover')=>({success:true,result:{bindings:[{name:'SUBSCRIPTIONS',type:'kv_namespace',namespace_id:namespace},{name:'DB',type:'d1',id:db},{name:'SUBSCRIPTION_STORAGE_MODE',type:'plain_text',text:mode},{name:'UNRELATED_SECRET',type:'plain_text',text:token}]}});
const options=(command)=>parseArguments([command,`--import-id=${id}`,...flags]);

test('CLI defaults read-only and every metadata/data write needs explicit acknowledgement flags',()=>{
 assert.deepEqual(parseArguments([]),{command:'status',importId:undefined,mutating:false});
 for(const command of ['begin','scan-page','promote-page','verify']){
  assert.throws(()=>parseArguments([command,`--import-id=${id}`]),e=>e.code==='SUBSCRIPTION_IMPORT_APPROVAL_FLAGS_REQUIRED');
  for(const flag of flags) assert.throws(()=>parseArguments([command,`--import-id=${id}`,...flags.filter(x=>x!==flag)]));
  assert.equal(options(command).mutating,true);
 }
 for(const command of ['activate','delete','cleanup','apply-schema','deploy']) assert.throws(()=>parseArguments([command]));
 assert.throws(()=>parseArguments(['begin','--import-id=../unsafe',...flags]));
});

test('bounded resumable CLI pipeline retains configuration/dedupe but emits counts only',async t=>{
 const DB=createD1();t.after(()=>DB.close());
 const entries=[['sub:private-a@example.test',record('private-a@example.test')],['sub:private-b@example.test',record('private-b@example.test')],['alert:private-a@example.test',record('private-a@example.test',{condition:'above',multiplier:2,lastAlertKeys:['known-key'],lastAlertAt:'2026-09-30T08:00:00Z'})]];
 const env={DB,SUBSCRIPTIONS:createKV(entries,{pageSize:1}),SUBSCRIPTION_STORAGE_MODE:'handover'};
 const outputs=[];outputs.push(await runImportCommand(options('begin'),env));
 let status;for(let i=0;i<5;i++){status=await runImportCommand(options('scan-page'),env);outputs.push(status);if(status.dailyComplete&&status.alertComplete)break;}
 assert.equal(status.dailyComplete,true);assert.equal(status.alertComplete,true);
 for(let i=0;i<5;i++){status=await runImportCommand(options('promote-page'),env);outputs.push(status);if(status.complete)break;}
 const verification=await runImportCommand(options('verify'),env);outputs.push(verification);
 assert.deepEqual(verification,{verified:true,count:3,daily:2,alert:1});
 assert.equal(DB.sqlite.prepare('SELECT last_sent_date FROM subscriptions WHERE kind=? AND email=?').get('daily','private-a@example.test').last_sent_date,'2026-09-30');
 const text=JSON.stringify(outputs);
 assert.equal(text.includes('@'),false);assert.equal(text.includes('cursor'),false);assert.equal(text.includes('known-key'),false);
 assert.equal(DB.sqlite.prepare('SELECT ready FROM subscription_storage_control').get().ready,0);
});

test('status remains read-only and usable after activation',async t=>{
 const DB=createD1({ready:true});t.after(()=>DB.close());const env={DB,SUBSCRIPTIONS:createKV(),SUBSCRIPTION_STORAGE_MODE:'d1'};
 DB.calls.length=0;const result=await runImportCommand(parseArguments([]),env);
 assert.equal(result.mode,'d1');assert.equal(result.ready,true);
 assert.equal(DB.calls.some(x=>/^\s*(INSERT|UPDATE|DELETE|CREATE)/i.test(x.sql??'')),false);
});

test('REST binding verification rejects wrong namespace and nonhandover writes without querying records',async()=>{
 let calls=0;
 await assert.rejects(createRestEnvironment({CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:token},{fetchImpl:async()=>{calls++;return Response.json(config('legacy'));}}),e=>e.code==='SUBSCRIPTION_IMPORT_LIVE_HANDOVER_REQUIRED');
 assert.equal(calls,1);
 const bad=config();bad.result.bindings[0].namespace_id='b'.repeat(32);
 await assert.rejects(createRestEnvironment({CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:token},{fetchImpl:async()=>Response.json(bad)}),e=>e.code==='SUBSCRIPTION_IMPORT_BINDING_MISMATCH');
});

test('REST status setup permits legacy mode and never exports unrelated binding values',async()=>{
 const env=await createRestEnvironment({CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:token},{requireHandover:false,fetchImpl:async()=>Response.json(config('legacy'))});
 assert.equal(env.SUBSCRIPTION_STORAGE_MODE,'legacy');assert.equal(JSON.stringify(env).includes(token),false);
});

test('REST adapters use fixed official paths, safe prefixes, complete cursor semantics and documented batch shape',async()=>{
 const calls=[];
 const fetchImpl=async(url,init)=>{
  calls.push({url,init});
  if(url.endsWith('/settings'))return Response.json(config());
  if(url.includes('/keys?'))return Response.json({success:true,result:[],result_info:{cursor:'opaque-next'}});
  if(url.includes('/values/'))return new Response(JSON.stringify(record('private@example.test')));
  if(url.endsWith('/query'))return Response.json({success:true,result:[{success:true,results:[],meta:{changes:0}}]});
  throw new Error('Unapproved test URL');
 };
 const env=await createRestEnvironment({CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:token},{fetchImpl});
 assert.deepEqual(await env.SUBSCRIPTIONS.list({prefix:'sub:',limit:100}),{keys:[],list_complete:false,cursor:'opaque-next'});
 await assert.rejects(env.SUBSCRIPTIONS.list({prefix:'session:',limit:100}));
 await assert.rejects(env.SUBSCRIPTIONS.get('session:private'));
 await env.SUBSCRIPTIONS.get('sub:private@example.test');
 await env.DB.batch([env.DB.prepare('SELECT ? AS value').bind('test')]);
 assert.deepEqual(JSON.parse(calls.at(-1).init.body),{batch:[{sql:'SELECT ? AS value',params:['test']}]});
 for(const call of calls){assert.ok(call.url.startsWith('https://api.cloudflare.com/client/v4/accounts/'+account+'/'));assert.equal(call.init.redirect,'error');assert.equal(call.init.headers.Authorization,'Bearer '+token);}
 assert.ok(calls.some(x=>x.url.endsWith('/values/sub%3Aprivate%40example.test')));
});

test('REST permission/network budget errors contain no response bodies or credentials',async()=>{
 await assert.rejects(createRestEnvironment({CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:token},{fetchImpl:async()=>new Response(token,{status:403})}),e=>e.code==='SUBSCRIPTION_IMPORT_PERMISSION_DENIED'&&!e.message.includes(token));
 let time=0;
 const env=await createRestEnvironment({CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:token},{now:()=>time,fetchImpl:async()=>Response.json(config())});
 time=120001;
 await assert.rejects(env.SUBSCRIPTIONS.list({prefix:'sub:'}),e=>e.code==='SUBSCRIPTION_IMPORT_REQUEST_BUDGET');
});
