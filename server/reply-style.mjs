// A response preference, not an output cap: requested detail/code stays complete.
export const DEFAULT_REPLY_STYLE = "Be brief by default. Use one-line greetings. Give requested details and complete code.";

export function withReplyStyle(messages) {
  // Internal chunk continuation already contains the trusted policy. Public
  // requests cannot supply system turns (validateRequest rejects them).
  if (messages[0]?.role === 'system' && messages[0].content === DEFAULT_REPLY_STYLE) return messages;
  return [{role:'system',content:DEFAULT_REPLY_STYLE},...messages];
}
