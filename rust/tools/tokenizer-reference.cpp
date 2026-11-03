// Acceptance oracle only. Loads GGUF vocabulary metadata, never model weights.
// Binary stdin: u32 batch count, then u32 byte length + UTF-8 bytes per input.
// Binary stdout: u32 batch count, then u32 token count + i32 IDs per input.
#include "llama.h"
#include <cstdint>
#include <cstdio>
#include <limits>
#include <string>
#include <vector>

static bool read_exact(void * value, size_t bytes) {
    return std::fread(value, 1, bytes, stdin) == bytes;
}
static bool write_exact(const void * value, size_t bytes) {
    return std::fwrite(value, 1, bytes, stdout) == bytes;
}
int main(int argc, char ** argv) {
    if (argc != 2) return 2;
    auto params = llama_model_default_params();
    params.vocab_only = true;
    params.n_gpu_layers = 0;
    auto * model = llama_model_load_from_file(argv[1], params);
    if (!model) return 3;
    const auto * vocab = llama_model_get_vocab(model);
    uint32_t count;
    if (!read_exact(&count, sizeof(count)) || count == 0 || count > 256 || !write_exact(&count, sizeof(count))) return 4;
    for (uint32_t i = 0; i < count; ++i) {
        uint32_t length;
        if (!read_exact(&length, sizeof(length)) || length > 131072) return 5;
        std::string content(length, '\0');
        if (!read_exact(content.data(), length)) return 6;
        const int needed = llama_tokenize(vocab, content.data(), static_cast<int32_t>(length), nullptr, 0, true, true);
        if (needed == std::numeric_limits<int>::min() || needed > 0) return 7;
        std::vector<llama_token> tokens(static_cast<size_t>(-needed));
        const int written = llama_tokenize(vocab, content.data(), static_cast<int32_t>(length), tokens.data(), static_cast<int32_t>(tokens.size()), true, true);
        if (written < 0 || written != -needed) return 8;
        uint32_t size = static_cast<uint32_t>(written);
        if (!write_exact(&size, sizeof(size)) || !write_exact(tokens.data(), size * sizeof(llama_token))) return 9;
    }
    if (std::fgetc(stdin) != EOF) return 10;
    llama_model_free(model);
    return std::fflush(stdout) == 0 ? 0 : 11;
}
