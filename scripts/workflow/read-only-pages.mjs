const pages=['/about','/purchases','/review/E003'];

export async function probeReadOnlyPages(origin,fetchImpl=globalThis.fetch) {
  if(!['http://127.0.0.1:4173','http://127.0.0.1:4183'].includes(origin))throw new Error('Unapproved runtime probe origin');
  for(const route of pages){
    const response=await fetchImpl(origin+route,{headers:{Accept:'text/html'},signal:AbortSignal.timeout(30000)});
    if(response.status!==200||!response.headers.get('content-type')?.includes('text/html'))throw new Error('Read-only page failed: '+route);
    if(!/<div\b[^>]*\bid=["']root["']/.test(await response.text()))throw new Error('Read-only page is not the application shell: '+route);
  }
  return {pages:pages.length};
}
