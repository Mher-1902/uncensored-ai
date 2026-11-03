#!/usr/bin/env python3
"""Patch only the reviewed native input boundary in a private candidate build.

The prediction engine and its native chat/reasoning parser remain unchanged.
The Rust gateway supplies verified token IDs; this hook avoids re-encoding its
rendered user prompt. It is not a replacement tokenizer or a public API.
"""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess

REVISION = '0504396140d1c882f5f6ee34466a42db7ae90114'
SOURCE_SHA256 = 'f141b9653d4c9eadca77667fb9fcb2a5f961208f76fce6d0b824d2b0127cd911'

CHAT_BEFORE = '''    this->post_chat_completions = [this](const server_http_req & req) {
        auto res = create_response();
        std::vector<raw_buffer> files;
        json body = json::parse(req.body);
        json body_parsed = oaicompat_chat_params_parse(
            body,
            meta->chat_params,
            files);
        return handle_completions_impl(
            req,
            SERVER_TASK_TYPE_COMPLETION,
            body_parsed,
            files,
            TASK_RESPONSE_TYPE_OAI_CHAT);
    };
'''

CHAT_AFTER = '''    this->post_chat_completions = [this](const server_http_req & req) {
        auto res = create_response();
        std::vector<raw_buffer> files;
        json body = json::parse(req.body);
        json body_parsed = oaicompat_chat_params_parse(
            body,
            meta->chat_params,
            files);
        // Offscript Rust prompt-token boundary v1. The listener is loopback.
        // The gateway cannot claim Rust tokenization while the engine silently
        // re-encodes a string prompt. Preserve native chat metadata and replace
        // only the prompt input after the exact template text is checked.
        const bool has_rust_tokens = body.contains("offscript_prompt_tokens");
        const bool has_rust_prompt = body.contains("offscript_rendered_prompt");
        if (has_rust_tokens || has_rust_prompt) {
            bool valid = has_rust_tokens && has_rust_prompt && files.empty();
            if (valid) {
                const auto & tokens = body.at("offscript_prompt_tokens");
                const auto & rendered = body.at("offscript_rendered_prompt");
                valid = tokens.is_array() && !tokens.empty() && tokens.size() <= 4096 &&
                        meta->model_vocab_n_tokens > 0 &&
                        rendered.is_string() && body_parsed.at("prompt").is_string() &&
                        rendered == body_parsed.at("prompt");
                if (valid) {
                    // This cached metadata is the loaded vocabulary's exact
                    // llama_vocab_n_tokens value and remains valid in sleep.
                    const auto n_vocab = static_cast<uint64_t>(meta->model_vocab_n_tokens);
                    for (const auto & token : tokens) {
                        if (token.is_number_unsigned()) {
                            valid = token.get<uint64_t>() < n_vocab;
                        } else if (token.is_number_integer()) {
                            const auto id = token.get<int64_t>();
                            valid = id >= 0 && static_cast<uint64_t>(id) < n_vocab;
                        } else {
                            valid = false;
                        }
                        if (!valid) { break; }
                    }
                }
                if (valid) {
                    // A numeric-only prompt takes the existing token-ID path;
                    // tokenize_input_prompts does not encode user text here.
                    body_parsed["prompt"] = tokens;
                }
            }
            if (!valid) {
                res->error(format_error_response("Invalid Rust prompt-token input.", ERROR_TYPE_INVALID_REQUEST));
                return res;
            }
        }
        return handle_completions_impl(
            req,
            SERVER_TASK_TYPE_COMPLETION,
            body_parsed,
            files,
            TASK_RESPONSE_TYPE_OAI_CHAT);
    };
'''

PROPS_BEFORE = '''    this->get_props = [this](const server_http_req &) {
        auto res = create_response(true);
        // note: do NOT use ctx_server here, this endpoint must be accessible during sleep
        if (queue_tasks.is_sleeping()) {
            std::unique_lock<std::mutex> lock(mutex_cache);
            res->ok(cached_props);
        } else {
            res->ok(get_res_props(*meta, params, false));
        }
        return res;
    };
'''

PROPS_AFTER = '''    this->get_props = [this](const server_http_req &) {
        auto res = create_response(true);
        // note: do NOT use ctx_server here, this endpoint must be accessible during sleep
        // Offscript Rust input-token capability v1, including cached sleep metadata.
        if (queue_tasks.is_sleeping()) {
            std::unique_lock<std::mutex> lock(mutex_cache);
            auto props = cached_props;
            props["offscript_input_tokens_version"] = 1;
            props["offscript_erase_state_version"] = 1;
            res->ok(props);
        } else {
            auto props = get_res_props(*meta, params, false);
            props["offscript_input_tokens_version"] = 1;
            props["offscript_erase_state_version"] = 1;
            res->ok(props);
        }
        return res;
    };
'''

ERASE_BEFORE = '''                    slot->prompt_clear();

                    auto res = std::make_unique<server_task_result_slot_erase>();
'''

ERASE_AFTER = '''                    slot->prompt_clear();
                    // Offscript explicit slot cleanup v1. reset() retains the
                    // preceding task for diagnostics and the mutable sampler.
                    // Explicit idle erasure also drops those reachable values;
                    // this does not claim forensic zeroization of allocator RAM.
                    slot->task_prev.reset();
                    slot->smpl.reset();
                    slot->debug_generated_text.clear();
                    slot->spec_prompt.clear();
                    slot->spec_draft_q.clear();

                    auto res = std::make_unique<server_task_result_slot_erase>();
'''

ERASE_RESPONSE_BEFORE = '''    GGML_ASSERT(dynamic_cast<server_task_result_slot_erase*>(result.get()) != nullptr);
    res->ok(result->to_json());
'''

ERASE_RESPONSE_AFTER = '''    GGML_ASSERT(dynamic_cast<server_task_result_slot_erase*>(result.get()) != nullptr);
    // Offscript slot cleanup receipt v1, separate from prompt-token capability.
    auto payload = result->to_json();
    payload["offscript_erase_state_version"] = 1;
    res->ok(payload);
'''

PATCHES = ((CHAT_BEFORE, CHAT_AFTER), (PROPS_BEFORE, PROPS_AFTER),
           (ERASE_BEFORE, ERASE_AFTER), (ERASE_RESPONSE_BEFORE, ERASE_RESPONSE_AFTER))


def restore_text(source: str) -> str:
    for before, after in PATCHES:
        source = source.replace(after, before, 1)
    return source


def patch_text(source: str) -> str:
    """Transform exact reviewed handlers; reject partial/ambiguous overlays."""
    markers = ('Offscript Rust prompt-token boundary v1', 'Offscript Rust input-token capability v1',
               'Offscript explicit slot cleanup v1', 'Offscript slot cleanup receipt v1')
    if any(marker in source for marker in markers):
        if any(source.count(after) != 1 for _, after in PATCHES):
            raise ValueError('Refusing a partial or modified Rust input-token patch.')
        if any(source.count(marker) != 1 for marker in markers):
            raise ValueError('Refusing duplicate Rust input-token patches.')
        restored = restore_text(source)
        if any(after in restored for _, after in PATCHES):
            raise ValueError('Refusing ambiguous patched handlers.')
        return source
    if any(source.count(before) != 1 for before, _ in PATCHES):
        raise ValueError('Pinned native input/properties/cleanup handlers do not match.')
    for before, after in PATCHES:
        source = source.replace(before, after, 1)
    return source


def patch_tree(root: Path) -> dict:
    revision = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True, timeout=10).strip()
    if revision != REVISION:
        raise ValueError('Refusing an unreviewed native revision.')
    path = root / 'tools/server/server-context.cpp'
    if path.is_symlink():
        raise ValueError('Refusing a symlink for the native source file.')
    original = path.read_bytes().decode('utf-8')
    updated = patch_text(original)
    restored = restore_text(original)
    if hashlib.sha256(restored.encode()).hexdigest() != SOURCE_SHA256:
        raise ValueError('Refusing modified or unreviewed native source bytes.')
    if updated != original:
        temporary = path.with_name(path.name + '.offscript-rust-input.tmp')
        if temporary.exists() or temporary.is_symlink():
            raise ValueError('Refusing a stale patch output file.')
        try:
            with temporary.open('x', encoding='utf-8', newline='\n') as output:
                output.write(updated)
            temporary.chmod(path.stat().st_mode & 0o777)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return {
        'revision': revision,
        'source_sha256': SOURCE_SHA256,
        'patched_sha256': hashlib.sha256(updated.encode()).hexdigest(),
        'changed': updated != original,
        'interface_version': 1,
        'erase_state_version': 1,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    arguments = parser.parse_args()
    print(json.dumps(patch_tree(arguments.source)), flush=True)


if __name__ == '__main__':
    main()
