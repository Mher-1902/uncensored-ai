// The larger pilot segment is opt-in through an explicit disabled account gate.
// Deep's first segment already includes a separate engine thinking allowance.
export function segmentMaxTokens(accountControl:boolean|undefined,deep:boolean):256|512{
  return accountControl===false&&!deep?512:256;
}
