export type ChatSession = {accessToken:string;userId:string};
export type SessionProvider = (refresh?:boolean)=>Promise<ChatSession|null>;
export type SessionSource = string|null|SessionProvider;

export class SessionExpiredError extends Error {
  constructor(){super('Your session expired. Your reply is still on this page. Copy it before signing in again; leaving this page clears the chat.');}
}
export class AccountChangedError extends Error {
  constructor(){super('Your account changed. Start a new question with the signed-in account.');}
}

type StoredSession = {access_token:string;user:{id:string}};
type SessionResult = {data:{session:StoredSession|null};error:unknown};
type AuthSessionReader = {getSession:()=>Promise<SessionResult>;refreshSession:()=>Promise<SessionResult>};

// Capture the account that owns this conversation before any asynchronous
// lookup. A later sign-in must not receive another account's chat or receipt.
export function accountSessionProvider(auth:AuthSessionReader|null,expectedUser:string|undefined):SessionProvider {
  return async(refresh=false)=>{
    if(!auth||!expectedUser)return null;
    let result:SessionResult;
    try {result=await (refresh?auth.refreshSession():auth.getSession());}
    catch {throw new SessionExpiredError();}
    if(result.error||!result.data.session?.access_token)throw new SessionExpiredError();
    const session=result.data.session;
    if(session.user.id!==expectedUser)throw new AccountChangedError();
    return {accessToken:session.access_token,userId:session.user.id};
  };
}

// Read a current token for each segment and independent cancellation. Neither
// session data nor generated content is written to storage or logs here.
export function sessionReader(source:SessionSource|undefined,required:boolean) {
  let owner:string|undefined;
  return {
    canRefresh:typeof source==='function',
    async token(refresh=false,signal?:AbortSignal):Promise<string|null> {
      signal?.throwIfAborted();
      if(typeof source!=='function') {
        if(required&&!source)throw new SessionExpiredError();
        return source||null;
      }
      let session:ChatSession|null;
      let onAbort:(()=>void)|undefined;
      try {
        const lookup=source(refresh);
        session=signal?await Promise.race([lookup,new Promise<never>((_resolve,reject)=>{
          onAbort=()=>reject(signal.reason);
          signal.addEventListener('abort',onAbort,{once:true});
          if(signal.aborted)onAbort();
        })]):await lookup;
      }
      catch(error) {
        signal?.throwIfAborted();
        if(error instanceof SessionExpiredError||error instanceof AccountChangedError)throw error;
        throw new SessionExpiredError();
      }
      finally {if(onAbort)signal?.removeEventListener('abort',onAbort);}
      signal?.throwIfAborted();
      if(!session) {
        if(required||owner!==undefined)throw new SessionExpiredError();
        return null;
      }
      if(!session.accessToken||!session.userId)throw new SessionExpiredError();
      if(owner!==undefined&&owner!==session.userId)throw new AccountChangedError();
      owner=session.userId;
      return session.accessToken;
    },
  };
}
