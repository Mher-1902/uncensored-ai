// Populate only after immutable public documents are reviewed and published.
// A database flag alone must not turn draft/broken links into an agreement.
const published:Readonly<Record<string,{terms:string;privacy:string}>>={};
export function policyLinks(termsVersion:string,privacyVersion:string){
  return published[`${termsVersion}/${privacyVersion}`]||null;
}
