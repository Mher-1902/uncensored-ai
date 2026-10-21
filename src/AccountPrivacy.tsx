import {PrivacyContent,PRIVACY_PATH} from './Privacy';
import {COOKIES_PATH} from './legal-paths';

export function AccountPrivacy({signup}:{signup:boolean}){
  if(!signup)return <p className="signin-privacy">Your provider shares sign-in details to create or access your account. <a href={PRIVACY_PATH} target="_blank" rel="noopener noreferrer">Privacy Policy</a> · <a href={COOKIES_PATH} target="_blank" rel="noopener noreferrer">Cookies</a></p>;
  return <section className="signup-privacy" aria-labelledby="signup-privacy-title"><h3 id="signup-privacy-title">Your account stays. Chats don’t.</h3><p>Your provider shares sign-in and profile details. Messages are processed to answer you, without a saved chat history. Infrastructure providers may keep operational records.</p><details><summary>Read the Privacy Policy</summary><PrivacyContent/><a href={PRIVACY_PATH} target="_blank" rel="noopener noreferrer">Open Privacy Policy in a new tab ↗</a></details><p className="muted">Creating an account does not subscribe you to marketing or a paid plan.</p></section>;
}
