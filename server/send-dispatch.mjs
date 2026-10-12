import {existingKeyE2EE} from './encryption-policy.mjs';

// The pinned Talk/Square SDK persists reqseq before calling request.request.
// Authorize at that RPC boundary, after the asynchronous storage acknowledgment.
// Per-operation views leave concurrent polling and other live RPCs untouched.
export function dispatchText(client,chat,options,beforeDispatch){
  const original=chat.kind==='openchat'?client.square:client.talk;
  const service=Object.create(original),view=Object.create(client),request=Object.create(client.request??null);
  service.client=view;view.request=request;
  // Keep sequence allocation on the real client, including its shared cache.
  view.getReqseq=(...args)=>client.getReqseq(...args);
  request.request=async(...args)=>{
    await beforeDispatch();
    return client.request.request(...args);
  };
  return service.sendMessage(options);
}

// Pinned LineJS 3.4.2 already implements encrypted personal-image upload.
// Use scoped views; authorize at the final Talk send RPC, not by mutating the live client.
export function dispatchImage(client,chat,bytes,mimeType,beforeDispatch){
  const view=Object.create(client),obs=Object.create(client.obs),talk=Object.create(client.talk);
  const request=Object.create(client.request),e2ee=existingKeyE2EE(client);
  obs.client=view;talk.client=view;e2ee.client=view;
  view.obs=obs;view.talk=talk;view.request=request;view.e2ee=e2ee;
  view.getReqseq=(...args)=>client.getReqseq(...args);
  // No SDK fallback/retry: always send the encrypted chunks explicitly.
  talk.sendMessage=options=>{
    if(!options?.chunks?.length)throw new Error('Encrypted image chunks are required.');
    return client.talk.sendMessage.call(talk,{...options,e2ee:true});
  };
  request.request=async(...args)=>{
    if(args[1]==='sendMessage')await beforeDispatch();
    return client.request.request(...args);
  };
  const filename=mimeType==='image/png'?'morning.png':'morning.jpg';
  return obs.uploadMediaByE2EE({to:chat.id,oType:'image',data:new Blob([bytes],{type:mimeType}),filename});
}
