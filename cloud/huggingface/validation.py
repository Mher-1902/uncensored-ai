"""Validate the public API without accepting client system instructions."""
def validate(messages, max_tokens):
    if not isinstance(messages, list) or not messages:
        raise ValueError("Send a question first.")
    if isinstance(max_tokens, bool) or not isinstance(max_tokens, (int, float)) or max_tokens not in (256, 512, 1024):
        raise ValueError("Choose Brief, Balanced, or Detailed.")
    cleaned = []
    for index, message in enumerate(messages):
        expected = "user" if index % 2 == 0 else "assistant"
        if not isinstance(message, dict) or message.get("role") != expected or not isinstance(message.get("content"), str) or not message["content"].strip():
            raise ValueError("Messages must alternate between user and assistant.")
        cleaned.append({"role": expected, "content": message["content"].strip()})
    if cleaned[-1]["role"] != "user":
        raise ValueError("End with your question.")
    return cleaned, int(max_tokens)
