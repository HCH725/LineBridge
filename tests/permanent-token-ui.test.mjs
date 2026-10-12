import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const script=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');

test('permanent token UI renders an explicit multi-friend checkbox list only for approved direct chats',async()=>{
  assert.match(html,/id="permanent-chat-list"/);
  const start=script.indexOf('async function updatePermanentScope(){');
  const end=script.indexOf("$('#token-form').querySelectorAll(",start);
  assert.ok(start>=0&&end>start);
  const nodes={'#token-form':{elements:{days:{value:'never'}}},'#permanent-scope':{hidden:true},'#permanent-chat-list':{innerHTML:''}};
  const accounts=[{id:'account-1',name:'Victor',designatedChats:3}];
  const api=async()=>[
    {id:'friend-1',name:'Friend A',kind:'direct',enabled:1},
    {id:'friend-2',name:'Friend B',kind:'direct',enabled:1},
    {id:'group-1',name:'Group C',kind:'group',enabled:1},
    {id:'friend-3',name:'Friend D',kind:'direct',enabled:0}
  ];
  const context={$:id=>nodes[id],state:{accounts},api,escape:x=>String(x),accountName:x=>x.name};
  await vm.runInNewContext(script.slice(start,end)+'\nupdatePermanentScope();',context);
  assert.equal(nodes['#permanent-scope'].hidden,false);
  const rendered=nodes['#permanent-chat-list'].innerHTML;
  assert.equal((rendered.match(/data-permanent-chat/g)||[]).length,2);
  assert.match(rendered,/Friend A/);assert.match(rendered,/Friend B/);
  assert.doesNotMatch(rendered,/Group C|Friend D/);
});

test('permanent token UI submits all checked friends for one account, not a wildcard',async()=>{
  const start=script.indexOf("$('#token-form').addEventListener('submit'");
  const end=script.indexOf("$('#copy-secret').addEventListener",start);
  assert.ok(start>=0&&end>start);
  const form={elements:{days:{value:'never'},name:{value:'Hermes Local Multi'}},reset(){}};
  const nodes={'#token-form':{addEventListener(_,fn){this.listener=fn;}},'#token-dialog':{close(){}},'#secret-dialog':{showModal(){}},'#new-secret':{value:''}};
  const selected=[
    {value:'friend-1',dataset:{account:'account-1'}},
    {value:'friend-2',dataset:{account:'account-1'}}
  ];
  const grantRow={dataset:{grant:'account-1'},querySelector:()=>({checked:true})};
  let request,job;
  const context={
    $:id=>nodes[id],
    document:{querySelectorAll:selector=>selector==='[data-grant]'?[grantRow]:selector==='[data-permanent-chat]:checked'?selected:[]},
    action:fn=>(job=fn()),
    api:async(path,options)=>{request={path,options};return {token:'synthetic-token'};},
    refresh:async()=>{}
  };
  vm.runInNewContext(script.slice(start,end),context);
  nodes['#token-form'].listener({preventDefault(){},currentTarget:form});
  await job;
  const body=JSON.parse(request.options.body);
  assert.equal(request.path,'/tokens');
  assert.equal(body.neverExpires,true);
  assert.equal(body.days,undefined);
  assert.equal(body.grants.length,1);
  assert.equal(body.grants[0].localOnly,true);
  assert.deepEqual(Array.from(body.grants[0].chatIds),['friend-1','friend-2']);
  assert.equal(nodes['#new-secret'].value,'synthetic-token');
});

test('permanent token rows render an edit-friends button wired to the scope editor',async()=>{
  const start=script.indexOf('function renderTokens(){');
  const end=script.indexOf('let localAccessSignature',start);
  assert.ok(start>=0&&end>start);
  const nodes={'#token-list':{innerHTML:''}};
  const tokens=[
    {id:'perm-1',name:'Perm',expires_at:'9999-12-31T23:59:59.999Z',revoked:0,grants:[{accountId:'a',read:true,send:true,chatIds:['x','y']}],last_used:null},
    {id:'finite-1',name:'Finite',expires_at:'2027-12-01T00:00:00.000Z',revoked:0,grants:[{accountId:'a',read:true,send:false}],last_used:null}
  ];
  const listeners={};
  const context={
    $:id=>nodes[id],
    state:{tokens,accounts:[{id:'a',label:'Victor'}]},
    icon:()=>'',badge:()=>'',escape:x=>String(x),short:x=>String(x),
    document:{querySelectorAll:sel=>sel==='[data-scope]'?[{dataset:{scope:'perm-1'},addEventListener(_,fn){listeners.scope=fn;}}]:[]},
    action:fn=>fn,api:async()=>{},toast:()=>{},refresh:async()=>{}
  };
  vm.runInNewContext(script.slice(start,end)+'\nrenderTokens();',context);
  const rendered=nodes['#token-list'].innerHTML;
  assert.match(rendered,/data-scope="perm-1"/);
  assert.equal((rendered.match(/data-scope="/g)||[]).length,1);
  assert.equal((rendered.match(/data-revoke="/g)||[]).length,2);
  assert.ok(typeof listeners.scope==='function');
});
