use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::BackendError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Fast,
    Deep,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatInput {
    pub messages: Vec<Message>,
    pub max_tokens: usize,
    pub mode: Mode,
    pub continuation: bool,
}

// JavaScript trim includes BOM but excludes NEL. Preserve the existing API's
// exact whitespace behavior, especially unfinished assistant/code prefixes.
fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn validate_request(value: Value, allow_bounded_tokens: bool) -> Result<ChatInput, BackendError> {
    let invalid_settings = || BackendError::new(400, "Invalid reply settings.");
    let object = value.as_object().ok_or_else(|| BackendError::new(400, "Send a message first."))?;
    let raw_messages = object.get("messages").and_then(Value::as_array)
        .filter(|items| !items.is_empty()).ok_or_else(|| BackendError::new(400, "Send a message first."))?;
    let reasoned = object.get("reasoned");
    let raw_mode = object.get("mode").filter(|item| !item.is_null());
    let mode = match raw_mode.and_then(Value::as_str) {
        Some("fast") => Mode::Fast,
        Some("deep") => Mode::Deep,
        None if raw_mode.is_none() => match reasoned.and_then(Value::as_bool) {
            Some(false) => Mode::Fast,
            Some(true) => Mode::Deep,
            None => return Err(invalid_settings()),
        },
        _ => return Err(invalid_settings()),
    };
    if let Some(raw) = reasoned {
        if raw.as_bool() != Some(mode == Mode::Deep) { return Err(invalid_settings()); }
    }
    let number = object.get("maxTokens").and_then(Value::as_f64).ok_or_else(invalid_settings)?;
    if !number.is_finite() || number.fract() != 0.0 || !(1.0..=1024.0).contains(&number) {
        return Err(invalid_settings());
    }
    let max_tokens = number as usize;
    if !allow_bounded_tokens && ![256, 512, 1024].contains(&max_tokens) { return Err(invalid_settings()); }
    let continuation = match object.get("continuation") {
        None => false,
        Some(Value::Bool(value)) => *value,
        _ => return Err(BackendError::new(400, "Invalid continuation.")),
    };
    if continuation && mode != Mode::Fast {
        return Err(BackendError::new(400, "Continue the answer without starting another thinking phase."));
    }
    let mut messages = Vec::with_capacity(raw_messages.len());
    for (index, raw) in raw_messages.iter().enumerate() {
        let role = if index % 2 == 0 { "user" } else { "assistant" };
        let invalid = || BackendError::new(400, "Invalid conversation. Clear the chat and try again.");
        if raw.get("role").and_then(Value::as_str) != Some(role) { return Err(invalid()); }
        let content = raw.get("content").and_then(Value::as_str).ok_or_else(invalid)?;
        let trimmed = content.trim_matches(js_space);
        if trimmed.is_empty() { return Err(invalid()); }
        messages.push(Message { role: role.to_owned(), content: if role == "user" { trimmed } else { content }.to_owned() });
    }
    if continuation && messages.len() % 2 != 0 {
        return Err(BackendError::new(400, "A continuation must end with the existing assistant answer."));
    }
    if !continuation && messages.len() % 2 == 0 {
        return Err(BackendError::new(400, "The last message must be a question."));
    }
    Ok(ChatInput { messages, max_tokens, mode, continuation })
}
