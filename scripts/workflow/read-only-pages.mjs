const pages=['/about','/purchases','/review/E003'];

export async function probeReadOnlyPages(origin,fetchImpl=globalThis.fetch) {
  let target;
  try{target=new URL(origin);}catch{throw new Error('Unapproved runtime probe origin');}
  if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.username||target.password||target.pathname!=='/'||target.search||target.hash
    ||!Number.isInteger(Number(target.port))||Number(target.port)<1024||Number(target.port)>49151)throw new Error('Unapproved runtime probe origin');
  origin=target.origin;
  for(const route of pages){
    const response=await fetchImpl(origin+route,{headers:{Accept:'text/html'},signal:AbortSignal.timeout(30000)});
    if(response.status!==200||!response.headers.get('content-type')?.includes('text/html'))throw new Error('Read-only page failed: '+route);
    if(!/<div\b[^>]*\bid=["']root["']/.test(await response.text()))throw new Error('Read-only page is not the application shell: '+route);
  }
  return {pages:pages.length};
}
