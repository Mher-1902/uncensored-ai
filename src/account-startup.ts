type Attempt<T>={start:()=>Promise<T>;dispose:()=>void};

function pause(milliseconds:number,signal:AbortSignal){
  return new Promise<void>(resolve=>{
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,milliseconds);signal.addEventListener('abort',done,{once:true});
    if(signal.aborted)done();
  });
}

// An SDK initialization promise can remain rejected after a mobile lock abort.
// Retry with a freshly owned client, never by reusing that rejected promise.
// Disposing an attempt fences its writes without erasing the saved envelope.
export async function startAccount<T>(
  create:()=>Attempt<T>,signal:AbortSignal,
  wait:(milliseconds:number,signal:AbortSignal)=>Promise<void>=pause,
):Promise<T|undefined>{
  for(let index=0;index<3&&!signal.aborted;index++){
    let attempt:Attempt<T>|undefined,disposed=false;
    const dispose=()=>{if(!disposed){disposed=true;attempt?.dispose();}};
    try{
      attempt=create();signal.addEventListener('abort',dispose,{once:true});
      if(signal.aborted){dispose();return;}
      const value=await attempt.start();
      if(signal.aborted){dispose();return;}
      // The effect's AbortController owns the successful client too.
      return value;
    }catch{
      signal.removeEventListener('abort',dispose);dispose();
      if(signal.aborted)return;
      if(index===2)throw Error('Sign-in could not connect. Please try again.');
      await wait(index===0?300:1000,signal);
    }
  }
}
