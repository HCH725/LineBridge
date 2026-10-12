import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createServer} from 'node:net';
import {Hub,localActor} from '../server/hub.mjs';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {createApps} from '../server/app.mjs';
import {Tunnels} from '../server/tunnels.mjs';
import {LineDriver} from '../server/drivers.mjs';
import {runCli} from '../client/cli.mjs';
import {dispatchImage} from '../server/send-dispatch.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=','base64');
async function fixture(t){
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),hub=new Hub(store,vault);
  t.after(()=>{hub.close();store.close();});
  const account=await hub.addAccount({label:'Test only',kind:'demo'});
  hub.addChat(account.id,{id:'u-friend',name:'Approved friend',kind:'direct'});
  hub.designate(account.id,'u-friend',true);
  hub.designate(account.id,'demo-group',true);
  return {store,hub,account};
}
test('image sending is limited to authorized direct chats, deduplicates and retains unknown outcomes',async t=>{
  const {store,hub,account}=await fixture(t);let calls=0;
  const driver=hub.driver(account.id);
  driver.sendImage=async(chat,input,check)=>{calls++;check();assert.equal(chat.id,'u-friend');assert.equal(input.mimeType,'image/png');return {messageId:'image-ok',delivery:'accepted_by_line',protection:'letter_sealing'};};
  await assert.rejects(hub.sendImage(localActor,account.id,'demo-group',png,'image-key-01'),{code:'image_direct_only'});
  await assert.rejects(hub.sendImage(localActor,account.id,'u-friend',Buffer.from('<svg/>'),'image-key-01'),{code:'media_unsupported'});
  const first=await hub.sendImage(localActor,account.id,'u-friend',png,'image-key-01');
  assert.equal(first.messageId,'image-ok');
  assert.equal((await hub.sendImage(localActor,account.id,'u-friend',png,'image-key-01')).replayed,true);
  assert.equal(calls,1);
  await assert.rejects(hub.send(localActor,account.id,'u-friend','hello','image-key-01'),{code:'idempotency_conflict'});
  hub.setLocalAccess(account.id,{read:true,send:false});
  await assert.rejects(hub.sendImage(localActor,account.id,'u-friend',png,'image-key-02'),{code:'scope_denied'});
  hub.setLocalAccess(account.id,{read:true,send:true});
  driver.sendImage=async()=>{calls++;throw new Error('simulated network timeout');};
  await assert.rejects(hub.sendImage(localActor,account.id,'u-friend',png,'image-key-03'),{code:'delivery_unknown'});
  await assert.rejects(hub.sendImage(localActor,account.id,'u-friend',png,'image-key-03'),{code:'delivery_unknown'});
  assert.equal(calls,2);assert.equal(store.send(localActor.id,'image-key-03').state,'unknown');
  assert.ok(!JSON.stringify(store.audits()).includes(png.toString('base64')));
});
test('one permanent local token can send an image separately to multiple approved direct friends',async t=>{
  const {hub,account}=await fixture(t);
  for(const id of ['u-friend-2','u-unapproved'])hub.addChat(account.id,{id,name:id,kind:'direct'});
  hub.designate(account.id,'u-friend-2',true);
  hub.designate(account.id,'u-unapproved',true);
  const grant={accountId:account.id,read:true,send:true,localOnly:true,chatIds:['u-friend','u-friend-2']};
  const token=hub.createToken({name:'Local multi friend',neverExpires:true,grants:[grant]});
  const actor=hub.authenticate(token.token),sent=[];
  hub.driver(account.id).sendImage=async(chat,_image,check)=>{check();sent.push(chat.id);return {messageId:'accepted-'+chat.id,delivery:'accepted_by_line'};};
  for(const id of grant.chatIds)assert.equal((await hub.sendImage(actor,account.id,id,png,'image-'+id)).messageId,'accepted-'+id);
  await assert.rejects(hub.sendImage(actor,account.id,'u-unapproved',png,'image-unapproved'),{code:'scope_denied'});
  await assert.rejects(hub.sendImage(actor,account.id,'demo-group',png,'image-group'),{code:'scope_denied'});
  assert.deepEqual(sent,grant.chatIds);
});
test('pinned SDK image upload uses encrypted chunks and rechecks scope only at send RPC',async t=>{
  const d=new LineDriver({device:'IOSIPAD'},{},{qr(){},pin(){},fault(){}});t.after(()=>d.stop());
  let uploads=0,rpc=0,authorized=0;
  d.client.getReqseq=async()=>1;
  d.client.obs.uploadObjectForService=async({data,obsPath})=>{uploads++;assert.ok(data.size>0);assert.ok(obsPath.includes('/emi/'));return {objId:'uploaded-1',headers:new Headers()};};
  d.client.e2ee.encryptByKeyMaterial=async()=>({keyMaterial:Buffer.alloc(32,1).toString('base64'),encryptedData:Buffer.from('encrypted bytes')});
  d.client.e2ee.encryptE2EEMessage=async(to,info,type)=>{assert.equal(to,'u-friend');assert.equal(type,1);assert.equal(info.fileName,'morning.png');return [Buffer.from('sealed chunk')];};
  d.client.request.request=async(message,method)=>{rpc++;assert.equal(method,'sendMessage');return {id:'sdk-image-ok',createdTime:1750000000000};};
  const result=await dispatchImage(d.client,{id:'u-friend',kind:'direct'},png,'image/png',()=>{authorized++;});
  assert.equal(result.id,'sdk-image-ok');assert.equal(uploads,2);assert.equal(rpc,1);assert.equal(authorized,1);
  assert.equal(d.client.obs.client,d.client); // The live SDK is never replaced by a scoped send view.
  await assert.rejects(dispatchImage(d.client,{id:'u-friend',kind:'direct'},png,'image/png',()=>{throw new Error('permission revoked');}),/permission revoked/);
  assert.equal(rpc,1); // The revoked send reached no Talk RPC.
});
test('image HTTP endpoint requires scoped credentials and refuses group destinations',async t=>{
  const {hub,store,account}=await fixture(t);
  const driver=hub.driver(account.id);
  driver.sendImage=async()=>({messageId:'http-image-ok',delivery:'accepted_by_line'});
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const tunnels=new Tunnels(store,hub.vault,process.cwd(),port);t.after(()=>tunnels.close());
  const {gateway}=createApps({hub,tunnels,root:process.cwd(),adminPort:0,gatewayPort:port});
  const server=gateway.listen(port,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
  const token=hub.createToken({name:'Image test',grants:[{accountId:account.id,read:false,send:true,chatIds:['u-friend']}]});
  const endpoint=`http://127.0.0.1:${port}/api/v1/accounts/${account.id}/chats/u-friend/image`;
  const headers={'Content-Type':'image/png','Idempotency-Key':'http-image-001'};
  assert.equal((await fetch(endpoint,{method:'POST',headers,body:png})).status,401);
  assert.equal((await fetch(endpoint,{method:'POST',headers:{...headers,Authorization:`Bearer ${token.token}`},body:png})).status,200);
  assert.equal((await fetch(endpoint,{method:'POST',headers:{...headers,Authorization:`Bearer ${token.token}`},body:png})).status,200);
  assert.equal((await fetch(endpoint.replace('u-friend','demo-group'),{method:'POST',headers:{...headers,Authorization:`Bearer ${token.token}`},body:png})).status,403);
  assert.equal((await fetch(endpoint,{method:'POST',headers:{...headers,Authorization:`Bearer ${token.token}`,'Content-Type':'text/plain'},body:png})).status,415);
});
test('Hermes CLI sends one validated local image as binary, never embeds file bytes in logs',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'linebridge-image-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'good.png');await writeFile(file,png);
  const invoke=async(fetchImpl)=>{let output='';const code=await runCli(['send-image','--account','a','--chat','u','--file',file,'--key','hermes-20261012-u'],{env:{LINE_BRIDGE_TOKEN:'synthetic'},stdin:Readable.from([]),stdout:{write:x=>output+=x},stderr:{write(){}},fetchImpl});return {code,output:JSON.parse(output)};};
  let calls=0;
  const result=await invoke(async(url,options)=>{calls++;assert.ok(url.endsWith('/accounts/a/chats/u/image'));assert.equal(options.headers['Content-Type'],'image/png');assert.equal(options.headers['Idempotency-Key'],'hermes-20261012-u');assert.deepEqual(Buffer.from(options.body),png);return new Response('{"messageId":"cli-image-ok"}');});
  assert.equal(result.code,0);assert.equal(calls,1);assert.equal(result.output.messageId,'cli-image-ok');assert.ok(!JSON.stringify(result).includes(png.toString('base64')));
  const failure=await invoke(async()=>{throw new Error('network timeout');});assert.equal(failure.output.error,'delivery_unknown');
  await writeFile(file,Buffer.from('not an image'));
  const bad=await invoke(()=>assert.fail('Malformed images must never reach the gateway'));assert.equal(bad.code,2);
  assert.deepEqual(await readFile(file),Buffer.from('not an image'));
});
test('send-image default timeout exceeds worker deadline while ordinary sends keep 45 seconds',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'linebridge-image-timeout-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'good.png');await writeFile(file,png);
  const observed=[];
  const timeout=AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal,'timeout',ms=>{observed.push(ms);return timeout(ms);});
  const invoke=async(args)=>{
    let output='';
    const code=await runCli(args,{
      env:{LINE_BRIDGE_TOKEN:'synthetic'},stdin:Readable.from([]),
      stdout:{write:value=>output+=value},stderr:{write(){}},
      fetchImpl:async()=>new Response('{"messageId":"synthetic-ok"}')
    });
    assert.equal(code,0,output);
    assert.equal(JSON.parse(output).messageId,'synthetic-ok');
  };
  const img=['send-image','--account','a','--chat','u','--file',file,'--key','good-morning-20261012-u'];
  await invoke(img);
  assert.equal(observed.at(-1),65000,'image default is longer than 60-second worker deadline');
  await invoke([...img,'--timeout-ms','80000']);
  assert.equal(observed.at(-1),80000,'explicit operator override wins');
  await invoke(['send','--account','a','--chat','u','--key','text-timeout-001','--text','hello']);
  assert.equal(observed.at(-1),45000,'existing text default remains unchanged');
});
