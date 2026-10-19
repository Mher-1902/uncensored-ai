// Engine-specific template, token accounting and request-state cleanup stay here.
// A future vLLM adapter must implement these operations rather than emulate slots.
export class EngineError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createLlamaEngine({origin, fetchImpl = fetch, contextTokens = 4096}) {
  const base = new URL(origin);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw Error('The model listener must be a loopback HTTP origin.');
  }
  const request = (path, options) => fetchImpl(new URL(path, base), options);
  return {
    async ready() {
      try { return (await request('/health', {signal: AbortSignal.timeout(3000)})).ok; }
      catch { return false; }
    },
    async dispose() {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if ((await request('/slots/0?action=erase', {method: 'POST', signal: AbortSignal.timeout(5000)})).ok) return true;
        } catch { /* A bounded retry is safe; never reuse an uncleared slot. */ }
      }
      return false;
    },
    async prepare({messages, maxTokens, mode, continuation = false}, signal) {
      const reasoning = mode === 'deep';
      const continuationOptions = continuation ? {continue_final_message: 'content', add_generation_prompt: false} : {};
      const headers = {'Content-Type': 'application/json'};
      const template = await request('/apply-template', {method: 'POST', headers, signal,
        body: JSON.stringify({messages, ...continuationOptions, chat_template_kwargs: {enable_thinking: reasoning}})});
      if (!template.ok) throw new EngineError(502, 'Could not prepare the model prompt.');
      const {prompt} = await template.json();
      if (typeof prompt !== 'string') throw new EngineError(502, 'The model returned an invalid template.');
      const tokenized = await request('/tokenize', {method: 'POST', headers, signal,
        body: JSON.stringify({content: prompt, add_special: true})});
      if (!tokenized.ok) throw new EngineError(502, 'Could not check the conversation length.');
      const {tokens} = await tokenized.json();
      if (!Array.isArray(tokens)) throw new EngineError(502, 'The model returned an invalid token count.');
      const remaining = contextTokens - tokens.length;
      if (remaining < (reasoning ? 128 : 32)) {
        throw new EngineError(422, 'This conversation has filled the model context. Start a new chat for another answer. Nothing was silently removed.');
      }
      // Only short prompts may use the candidate's larger 512-token segment.
      // Larger prefixes retain the old budget and its request-deadline margin.
      // Count the actual template, including a continuation's assistant prefix.
      const segmentBudget = !reasoning && maxTokens === 512 && tokens.length > 128 ? 256 : maxTokens;
      const outputBudget = Math.min(segmentBudget + (reasoning ? 256 : 0), remaining);
      const reasoningBudget = reasoning ? Math.min(256, outputBudget - 128) : 0;
      return {messages, reasoning, outputBudget, reasoningBudget, continuationOptions};
    },
    async generate({messages, reasoning, outputBudget, reasoningBudget, continuationOptions}, signal) {
      const result = await request('/v1/chat/completions', {method: 'POST', signal,
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
          model: 'offscript', messages, stream: true, stream_options: {include_usage: true},
          ...continuationOptions,
          max_tokens: outputBudget, temperature: reasoning ? 0.6 : 0.7,
          top_p: reasoning ? 0.95 : 0.8, top_k: 20, min_p: 0,
          chat_template_kwargs: {enable_thinking: reasoning},
          ...(reasoning ? {reasoning_budget_tokens: reasoningBudget} : {}),
          cache_prompt: false, id_slot: 0,
        })});
      if (!result.ok || !result.body) throw new EngineError(502, 'The model could not answer. Please try again.');
      return result;
    },
  };
}
