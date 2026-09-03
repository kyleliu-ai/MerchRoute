// All adapters must perform real checks. An interrupted journal is never treated
// as an accepted release; explicit recovery is required before another cutover.
export async function switchRelease({previous,candidate,check,stop,start,probe,bind,accept,journal,rollbackCheck}) {
  await check(previous,candidate);
  await journal({state:'PREPARED',previous,candidate});
  let stopped=false;
  try{
    await stop(previous);stopped=true;
    await journal({state:'STOPPED',previous,candidate});
    await bind(candidate);
    const running=await start(candidate);
    await journal({state:'STARTED',previous,candidate,running});
    await probe(candidate,running,1);await probe(candidate,running,2);
    await accept(candidate,running);
    await journal({state:'ACCEPTED',previous,candidate,running});
    return {accepted:true,running};
  }catch(error){
    await journal({state:'FAILED',previous,candidate,error:String(error.message)});
    if(stopped){
      try{await rollbackCheck(previous,candidate);await stop(candidate);await bind(previous);await start(previous);
        await journal({state:'ROLLED_BACK',previous,candidate});
      }catch(rollback){await journal({state:'RECOVERY_REQUIRED',previous,candidate,error:String(rollback.message)});}
    }
    throw error;
  }
}
