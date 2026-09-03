// All adapters must perform real checks. An interrupted journal is never treated
// as an accepted release; explicit recovery is required before another cutover.
export async function switchRelease({previous,candidate,check,stop,start,probe,bind,accept,journal,rollbackCheck}) {
  await check(previous,candidate);
  await journal({state:'PREPARED',previous,candidate});
  let stopped=false,acceptanceStarted=false;
  async function recordFailure(value){try{await journal(value);}catch{/* Preserve the original failure even if journal storage is unavailable. */}}
  try{
    await stop(previous);stopped=true;
    await journal({state:'STOPPED',previous,candidate});
    await bind(candidate);
    const running=await start(candidate);
    await journal({state:'STARTED',previous,candidate,running});
    await probe(candidate,running,1);await probe(candidate,running,2);
    acceptanceStarted=true;
    await accept(candidate,running);
    await journal({state:'ACCEPTED',previous,candidate,running});
    return {accepted:true,running};
  }catch(error){
    // The acceptance write may already have committed. Never restore old code
    // while its accepted record may now identify the verified new runtime.
    if(acceptanceStarted){await recordFailure({state:'RECOVERY_REQUIRED',previous,candidate,acceptanceWriteUncertain:true,error:String(error.message)});throw error;}
    await recordFailure({state:'FAILED',previous,candidate,error:String(error.message)});
    if(stopped){
      try{await rollbackCheck(previous,candidate);await stop(candidate);await bind(previous);const running=await start(previous);
        await probe(previous,running,1);await probe(previous,running,2);
        await journal({state:'ROLLED_BACK',previous,candidate,running});
      }catch(rollback){await recordFailure({state:'RECOVERY_REQUIRED',previous,candidate,error:String(rollback.message)});}
    }
    throw error;
  }
}
