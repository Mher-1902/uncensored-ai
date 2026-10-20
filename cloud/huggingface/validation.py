"""Bound the candidate API before tokenization; never silently shorten history."""
MAX_MESSAGES = 63
MAX_CHARACTERS = 65536


def validate(messages, max_tokens):
    if not isinstance(messages, list) or not messages:
        raise ValueError("Send a question first.")
    if len(messages) > MAX_MESSAGES:
        raise ValueError("This conversation is too long. Clear it or shorten your question.")
    if type(max_tokens) is not int or max_tokens not in (256, 512, 1024):
        raise ValueError("Use a supported token budget.")
    cleaned = []
    characters = 0
    for index, message in enumerate(messages):
        expected = "user" if index % 2 == 0 else "assistant"
        if (not isinstance(message, dict) or set(message) != {"role", "content"}
                or message.get("role") != expected or not isinstance(message.get("content"), str)
                or not message["content"].strip()):
            raise ValueError("Messages must alternate between user and assistant.")
        characters += len(message["content"])
        if characters > MAX_CHARACTERS:
            raise ValueError("This conversation is too long. Clear it or shorten your question.")
        # Code indentation and trailing newlines in an assistant answer are data.
        cleaned.append({"role": expected, "content": message["content"]})
    if cleaned[-1]["role"] != "user":
        raise ValueError("End with your question.")
    return cleaned, max_tokens
