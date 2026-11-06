import type {AccountPersistence} from './account-persistence';

type AccountSession={access_token:string;user:{id:string}};
type ResumePersistence=Pick<AccountPersistence,'lease'|'leaseCurrent'|'accepts'>;

// Mobile browsers may restore a frozen page without remounting React. Recover
// through the SDK when that happens or connectivity returns; a network failure
// must not erase a saved session or force another provider sign-in.
export function accountSessionResumer<T extends AccountSession>(
  auth:{getSession:()=>Promise<{data:{session:T|null};error:unknown}>},
  persistence:ResumePersistence,
  restored:(session:T)=>void,
){
  let disposed=false,pending:Promise<void>|null=null;
  return {
    resume():Promise<void>{
      if(disposed)return Promise.resolve();
      if(pending)return pending;
      const captured=persistence.lease();if(!captured)return Promise.resolve();
      pending=Promise.resolve().then(()=>auth.getSession()).then(result=>{
        const session=result.data.session;
        if(!disposed&&!result.error&&session&&persistence.leaseCurrent(captured)&&persistence.accepts(session))restored(session);
      }).catch(()=>{/* Keep current credentials; the next return/online event can retry. */}).finally(()=>{pending=null;});
      return pending;
    },
    dispose(){disposed=true;},
  };
}

export function listenForAccountReturn(target:EventTarget,onReturn:()=>void){
  target.addEventListener('pageshow',onReturn);
  target.addEventListener('online',onReturn);
  return ()=>{target.removeEventListener('pageshow',onReturn);target.removeEventListener('online',onReturn);};
}
