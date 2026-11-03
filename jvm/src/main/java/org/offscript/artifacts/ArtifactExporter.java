package org.offscript.artifacts;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.DigestOutputStream;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.Comparator;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Offline metadata preparation only. It never serves requests or loads tensors. */
public final class ArtifactExporter {
    public static final String MODEL_SHA256 = "be3ccca13a9d1bc8b67165ea80bd103cd6151a37ad131183cc7ca388f78d9517";
    public static final long MODEL_BYTES = 1_270_808_032L;
    public static final int VOCAB_COUNT = 248_320;
    public static final int MERGE_COUNT = 247_587;
    public static final long MAX_ARTIFACT = 33_554_432L;
    static final String QWEN35 = "(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\\r\\n\\p{L}\\p{N}]?[\\p{L}\\p{M}]+|\\p{N}| ?[^\\s\\p{L}\\p{M}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";
    static final JsonFactory JSON = JsonFactory.builder()
        .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
        .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(32).maxNumberLength(32).maxStringLength((int) MAX_ARTIFACT).build())
        .build();
    private static final Set<String> MANIFEST_KEYS = Set.of("schema", "model_sha256", "tokenizer_sha256", "vocab_count", "merge_count", "pre", "add_bos", "bos_token_id");
    private ArtifactExporter() {}

    public static final class ArtifactException extends IOException {
        public ArtifactException(String message) { super(message); }
    }
    record Profile(String modelSha256, long bytes, String configSha256) {}
    record TokenizerData(String[] vocab, String[] merges, int[] types, boolean addBos, Integer bosId) {}

    public static void requirePinnedJava() throws ArtifactException {
        var version = Runtime.version();
        require(version.feature() == 21 && version.interim() == 0 && version.update() == 13 && version.patch() == 0 && version.build().orElse(-1) == 9,
            "Use the pinned Temurin Java21.0.13+9 toolchain.");
    }

    public static String exportTokenizer(Path model, Path config, Path destination) throws IOException {
        Path output = normalized(destination);
        require(!Files.exists(output, LinkOption.NOFOLLOW_LINKS), "Output directory must be new.");
        Path parent = output.getParent();
        require(parent != null && Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS), "Output parent directory must already exist.");
        rejectSymlinks(parent);
        // The caller controls this directory; another tool invocation cannot
        // race publication. Lock/output artifacts contain model metadata only.
        Path lock = parent.resolve("." + output.getFileName() + ".offscript-export.lock");
        // Acquire before entering try/finally: if CREATE_NEW fails, this process
        // must not remove a lock belonging to an earlier invocation.
        var held = Files.newByteChannel(lock, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
        try (held) {
            Files.setPosixFilePermissions(lock, PosixFilePermissions.fromString("rw-------"));
            require(!Files.exists(output, LinkOption.NOFOLLOW_LINKS), "Output directory must be new.");
            Profile profile = profile(config);
            verifyModel(model, profile);
            TokenizerData data = readTokenizer(model);
            validateKnownTokenizer(data);
            Path stage = Files.createTempDirectory(parent, "." + output.getFileName() + ".staging-", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            boolean published = false;
            try {
                String tokenizerHash = writeTokenizer(stage.resolve("tokenizer.json"), data);
                Map<String,Object> manifest = manifest(profile, data, tokenizerHash);
                writeJson(stage.resolve("manifest.json"), manifest, 4096);
                String manifestHash = digest(stage.resolve("manifest.json"), 4096);
                Map<String,Object> provenance = provenance(profile, tokenizerHash, manifestHash);
                writeJson(stage.resolve("provenance.json"), provenance, 4096);
                String provenanceHash = digest(stage.resolve("provenance.json"), 4096);
                Files.writeString(stage.resolve("provenance.sha256"), provenanceHash + "\n", StandardCharsets.US_ASCII, StandardOpenOption.CREATE_NEW);
                for (String name : List.of("tokenizer.json", "manifest.json", "provenance.json", "provenance.sha256"))
                    Files.setPosixFilePermissions(stage.resolve(name), PosixFilePermissions.fromString("r--r--r--"));
                verifyDirectory(stage, profile, data);
                Files.setPosixFilePermissions(stage, PosixFilePermissions.fromString("rwxr-xr-x"));
                require(!Files.exists(output, LinkOption.NOFOLLOW_LINKS), "Output directory must be new.");
                try { Files.move(stage, output, StandardCopyOption.ATOMIC_MOVE); }
                catch (AtomicMoveNotSupportedException error) { throw new ArtifactException("Atomic publication is unavailable; no output was published."); }
                published = true;
                return jsonString(manifest);
            } finally {
                if (!published) deleteStaging(stage);
            }
        } finally {
            // Only remove a lock successfully acquired by this invocation.
            // A CREATE_NEW failure occurs before entering this finally block.
            Files.deleteIfExists(lock);
        }
    }

    public static String verifyArtifacts(Path model, Path config, Path directory) throws IOException {
        Profile profile = profile(config);
        verifyModel(model, profile);
        TokenizerData data = readTokenizer(model);
        validateKnownTokenizer(data);
        verifyDirectory(normalized(directory), profile, data);
        return "{\"verified\":true,\"schema\":1,\"vocab_count\":" + VOCAB_COUNT + ",\"merge_count\":" + MERGE_COUNT + "}";
    }

    static Profile profile(Path config) throws IOException {
        Map<String,Object> values = readObject(config, 65_536);
        String sha = text(values.get("sha256"));
        long bytes = number(values.get("bytes"));
        require(MODEL_SHA256.equals(sha) && bytes == MODEL_BYTES, "Selected model identity differs.");
        return new Profile(sha, bytes, digest(config, 65_536));
    }

    private static void verifyModel(Path model, Profile profile) throws IOException {
        regularFile(model, profile.bytes());
        require(Files.size(model) == profile.bytes(), "Selected model size differs.");
        require(digest(model, profile.bytes()).equals(profile.modelSha256()), "Selected model checksum differs.");
    }

    static TokenizerData readTokenizer(Path path) throws IOException {
        try (var reader = new GgufReader(path)) {
            require(reader.u32() == 0x46554747L && reader.u32() == 3 && reader.u64() == 320, "Wrong GGUF model.");
            long metadataCount = reader.u64();
            require(metadataCount <= 10_000, "Too many metadata fields.");
            String kind = null, pre = null; String[] vocab = null, merges = null; int[] types = null; boolean addBos = false; Integer bos = null;
            Set<String> keys = new HashSet<>();
            for (long index = 0; index < metadataCount; index++) {
                String key = reader.string(); require(keys.add(key), "Duplicate GGUF metadata key.");
                int type = reader.type();
                switch (key) {
                    case "tokenizer.ggml.model" -> { require(type == 8, "Invalid tokenizer model type."); kind = reader.string(); }
                    case "tokenizer.ggml.pre" -> { require(type == 8, "Invalid tokenizer pre-type."); pre = reader.string(); }
                    case "tokenizer.ggml.tokens" -> { require(type == 9, "Invalid vocabulary metadata."); vocab = reader.strings(); }
                    case "tokenizer.ggml.merges" -> { require(type == 9, "Invalid merge metadata."); merges = reader.strings(); }
                    case "tokenizer.ggml.token_type" -> { require(type == 9, "Invalid token-type metadata."); types = reader.integers(); }
                    case "tokenizer.ggml.add_bos_token" -> { require(type == 7, "Invalid BOS metadata."); addBos = reader.bool(); }
                    case "tokenizer.ggml.bos_token_id" -> { require(type == 4, "Invalid BOS identifier type."); long value = reader.u32(); require(value <= Integer.MAX_VALUE, "Invalid BOS identifier."); bos = (int)value; }
                    default -> reader.skip(type);
                }
            }
            require("gpt2".equals(kind) && "qwen35".equals(pre), "Unsupported tokenizer.");
            require(vocab != null && merges != null && types != null, "Tokenizer metadata is incomplete.");
            TokenizerData data = new TokenizerData(vocab, merges, types, addBos, bos);
            validateBasic(data);
            return data;
        }
    }

    static void validateBasic(TokenizerData data) throws ArtifactException {
        require(data.vocab().length == data.types().length && data.vocab().length > 0, "Vocabulary identity mismatch.");
        Set<String> unique = new HashSet<>();
        for (String token : data.vocab()) require(unique.add(token), "Vocabulary identity mismatch.");
        for (String merge : data.merges()) {
            String[] pair = merge.split(" ", -1);
            require(pair.length == 2 && unique.contains(pair[0]) && unique.contains(pair[1]), "Invalid merge pair.");
        }
        require(!data.addBos() || data.bosId() != null, "BOS metadata is incomplete.");
        require(data.bosId() == null || data.bosId() >= 0 && data.bosId() < data.vocab().length, "Invalid BOS identifier.");
    }

    static void validateKnownTokenizer(TokenizerData data) throws ArtifactException {
        require(data.vocab().length == VOCAB_COUNT && data.merges().length == MERGE_COUNT, "Vocabulary identity mismatch.");
    }

    static String writeTokenizer(Path path, TokenizerData data) throws IOException {
        MessageDigest hash = sha256();
        try (var file = Files.newOutputStream(path, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
             var bounded = new BoundedOutput(file, MAX_ARTIFACT);
             var checked = new DigestOutputStream(bounded, hash);
             var json = JSON.createGenerator(checked)) {
            json.writeStartObject(); json.writeStringField("version", "1.0"); json.writeNullField("truncation"); json.writeNullField("padding");
            json.writeArrayFieldStart("added_tokens");
            for (int id = 0; id < data.vocab().length; id++) if (data.types()[id] == 3 || data.types()[id] == 4) {
                json.writeStartObject(); json.writeNumberField("id", id); json.writeStringField("content", data.vocab()[id]);
                json.writeBooleanField("single_word", false); json.writeBooleanField("lstrip", false); json.writeBooleanField("rstrip", false);
                json.writeBooleanField("normalized", false); json.writeBooleanField("special", true); json.writeEndObject();
            }
            json.writeEndArray(); json.writeNullField("normalizer"); json.writeFieldName("pre_tokenizer"); writeValue(json, preTokenizer());
            json.writeNullField("post_processor"); json.writeFieldName("decoder"); writeValue(json, byteLevel());
            json.writeObjectFieldStart("model"); json.writeStringField("type", "BPE");
            for (String field : List.of("dropout", "unk_token", "continuing_subword_prefix", "end_of_word_suffix")) json.writeNullField(field);
            for (String field : List.of("fuse_unk", "byte_fallback", "ignore_merges")) json.writeBooleanField(field, false);
            json.writeObjectFieldStart("vocab");
            for (int id = 0; id < data.vocab().length; id++) json.writeNumberField(data.vocab()[id], id);
            json.writeEndObject(); json.writeArrayFieldStart("merges");
            for (String merge : data.merges()) {
                String[] pair = merge.split(" ", -1); require(pair.length == 2, "Invalid merge pair.");
                json.writeStartArray(); json.writeString(pair[0]); json.writeString(pair[1]); json.writeEndArray();
            }
            json.writeEndArray(); json.writeEndObject(); json.writeEndObject(); json.writeRaw('\n');
        }
        return HexFormat.of().formatHex(hash.digest());
    }

    private static Map<String,Object> byteLevel() {
        return linked("type", "ByteLevel", "add_prefix_space", false, "trim_offsets", false, "use_regex", false);
    }
    private static Map<String,Object> preTokenizer() {
        return linked("type", "Sequence", "pretokenizers", List.of(linked("type", "Split", "pattern", Map.of("Regex", QWEN35), "behavior", "Isolated", "invert", false), byteLevel()));
    }
    private static Map<String,Object> manifest(Profile profile, TokenizerData data, String hash) {
        return linked("schema", 1L, "model_sha256", profile.modelSha256(), "tokenizer_sha256", hash, "vocab_count", (long)data.vocab().length,
            "merge_count", (long)data.merges().length, "pre", "qwen35", "add_bos", data.addBos(), "bos_token_id", data.bosId() == null ? null : data.bosId().longValue());
    }
    private static Map<String,Object> provenance(Profile profile, String tokenizerHash, String manifestHash) {
        return linked("schema", 1L, "tool", "offscript-offline-artifacts", "scala", "3.3.9", "java", "21.0.13+9", "jackson_core", "2.18.7",
            "model_sha256", profile.modelSha256(), "model_bytes", profile.bytes(), "config_sha256", profile.configSha256(),
            "tokenizer_sha256", tokenizerHash, "manifest_sha256", manifestHash);
    }

    private static void verifyDirectory(Path directory, Profile profile, TokenizerData data) throws IOException {
        rejectSymlinks(directory); require(Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS), "Artifact directory is unavailable.");
        Path tokenizer = directory.resolve("tokenizer.json"); String tokenHash = digest(tokenizer, MAX_ARTIFACT);
        Map<String,Object> saved = readObject(directory.resolve("manifest.json"), 4096);
        require(saved.keySet().equals(MANIFEST_KEYS) && saved.equals(manifest(profile, data, tokenHash)), "Artifact manifest differs.");
        verifyTokenizer(tokenizer, data);
        String manifestHash = digest(directory.resolve("manifest.json"), 4096);
        Path provenance = directory.resolve("provenance.json");
        require(readObject(provenance, 4096).equals(provenance(profile, tokenHash, manifestHash)), "Artifact provenance differs.");
        Path checksum = directory.resolve("provenance.sha256"); regularFile(checksum, 65);
        require(Files.readString(checksum, StandardCharsets.US_ASCII).equals(digest(provenance, 4096) + "\n"), "Artifact provenance checksum differs.");
    }

    static void verifyTokenizer(Path tokenizer, TokenizerData data) throws IOException {
        regularFile(tokenizer, MAX_ARTIFACT);
        try (JsonParser json = JSON.createParser(tokenizer.toFile())) {
            require(json.nextToken() == JsonToken.START_OBJECT, "Invalid tokenizer JSON.");
            Set<String> seen = new HashSet<>(); BitSet special = new BitSet(data.vocab().length);
            for (int id = 0; id < data.types().length; id++) if (data.types()[id] == 3 || data.types()[id] == 4) special.set(id);
            while (json.nextToken() != JsonToken.END_OBJECT) {
                require(json.currentToken() == JsonToken.FIELD_NAME, "Invalid tokenizer JSON."); String key = json.currentName(); seen.add(key); json.nextToken();
                switch (key) {
                    case "version" -> require("1.0".equals(readValue(json)), "Tokenizer version differs.");
                    case "truncation", "padding", "normalizer", "post_processor" -> require(json.currentToken() == JsonToken.VALUE_NULL, "Tokenizer normalization or truncation differs.");
                    case "pre_tokenizer" -> require(preTokenizer().equals(readValue(json)), "Qwen3.5 splitting rules differ.");
                    case "decoder" -> require(byteLevel().equals(readValue(json)), "Tokenizer decoder differs.");
                    case "added_tokens" -> {
                        require(json.currentToken() == JsonToken.START_ARRAY, "Special tokens differ."); BitSet actual = new BitSet(data.vocab().length);
                        while (json.nextToken() != JsonToken.END_ARRAY) {
                            Object value = readValue(json); require(value instanceof Map<?,?>, "Special tokens differ."); Map<?,?> entry = (Map<?,?>)value;
                            int id = checkedId(number(entry.get("id")), data.vocab().length);
                            require(!actual.get(id) && special.get(id), "Special tokens differ.");actual.set(id);
                            require(entry.equals(linked("id", (long)id, "content", data.vocab()[id], "single_word", false, "lstrip", false, "rstrip", false, "normalized", false, "special", true)), "Special-token behavior differs.");
                        }
                        require(actual.equals(special), "Special tokens differ.");
                    }
                    case "model" -> verifyBpe(json, data);
                    default -> throw new ArtifactException("Unexpected tokenizer field.");
                }
            }
            require(seen.equals(Set.of("version", "truncation", "padding", "added_tokens", "normalizer", "pre_tokenizer", "post_processor", "decoder", "model")) && json.nextToken() == null, "Incomplete tokenizer JSON.");
        }
    }

    private static void verifyBpe(JsonParser json, TokenizerData data) throws IOException {
        require(json.currentToken() == JsonToken.START_OBJECT, "Invalid BPE model."); Set<String> seen = new HashSet<>();
        while (json.nextToken() != JsonToken.END_OBJECT) {
            require(json.currentToken() == JsonToken.FIELD_NAME, "Invalid BPE model."); String key = json.currentName();seen.add(key);json.nextToken();
            switch (key) {
                case "type" -> require("BPE".equals(readValue(json)), "BPE model type differs.");
                case "dropout", "unk_token", "continuing_subword_prefix", "end_of_word_suffix" -> require(json.currentToken() == JsonToken.VALUE_NULL, "BPE options differ.");
                case "fuse_unk", "byte_fallback", "ignore_merges" -> require(json.currentToken() == JsonToken.VALUE_FALSE, "BPE options differ.");
                case "vocab" -> {
                    require(json.currentToken() == JsonToken.START_OBJECT, "Invalid vocabulary."); BitSet ids = new BitSet(data.vocab().length); int count = 0;
                    while (json.nextToken() != JsonToken.END_OBJECT) {
                        require(json.currentToken() == JsonToken.FIELD_NAME, "Invalid vocabulary.");String token = json.currentName();require(json.nextToken() == JsonToken.VALUE_NUMBER_INT, "Invalid token ID.");
                        int id = checkedId(json.getLongValue(), data.vocab().length);require(!ids.get(id) && data.vocab()[id].equals(token), "Vocabulary IDs differ.");ids.set(id);count++;
                    }
                    require(count == data.vocab().length, "Vocabulary IDs differ.");
                }
                case "merges" -> {
                    require(json.currentToken() == JsonToken.START_ARRAY, "Invalid merges.");int count = 0;
                    while (json.nextToken() != JsonToken.END_ARRAY) {
                        require(count < data.merges().length && json.currentToken() == JsonToken.START_ARRAY, "Merge ranks differ.");
                        String[] expected = data.merges()[count++].split(" ", -1);
                        require(json.nextToken() == JsonToken.VALUE_STRING && expected[0].equals(json.getText()), "Merge ranks differ.");
                        require(json.nextToken() == JsonToken.VALUE_STRING && expected[1].equals(json.getText()), "Merge ranks differ.");
                        require(json.nextToken() == JsonToken.END_ARRAY, "Merge ranks differ.");
                    }
                    require(count == data.merges().length, "Merge ranks differ.");
                }
                default -> throw new ArtifactException("Unexpected BPE option.");
            }
        }
        require(seen.equals(Set.of("type", "dropout", "unk_token", "continuing_subword_prefix", "end_of_word_suffix", "fuse_unk", "byte_fallback", "ignore_merges", "vocab", "merges")), "Incomplete BPE model.");
    }

    static Map<String,Object> readObject(Path path, long max) throws IOException {
        regularFile(path, max);
        try (var json = JSON.createParser(path.toFile())) {
            require(json.nextToken() == JsonToken.START_OBJECT, "Expected a JSON object.");Object value = readValue(json);
            require(json.nextToken() == null, "Unexpected trailing JSON.");
            @SuppressWarnings("unchecked") Map<String,Object> result = (Map<String,Object>)value;return result;
        }
    }
    static Object readValue(JsonParser json) throws IOException {
        JsonToken current = json.currentToken(); require(current != null, "Incomplete JSON.");
        return switch (current) {
            case START_OBJECT -> {Map<String,Object> values = new LinkedHashMap<>();while (json.nextToken() != JsonToken.END_OBJECT) {require(json.currentToken() == JsonToken.FIELD_NAME, "Invalid JSON object.");String key = json.currentName();require(key.length() <= 1_048_576, "JSON field is too long.");json.nextToken();values.put(key, readValue(json));} yield values;}
            case START_ARRAY -> {List<Object> values = new ArrayList<>();while (json.nextToken() != JsonToken.END_ARRAY) {require(values.size() < 1_000_000, "JSON array is too large.");values.add(readValue(json));} yield values;}
            case VALUE_STRING -> json.getText();
            case VALUE_NUMBER_INT -> json.getLongValue();
            case VALUE_NUMBER_FLOAT -> json.getDoubleValue();
            case VALUE_TRUE -> Boolean.TRUE;
            case VALUE_FALSE -> Boolean.FALSE;
            case VALUE_NULL -> null;
            default -> throw new ArtifactException("Invalid JSON value.");
        };
    }
    static Map<String,Object> linked(Object... entries) {
        var map = new LinkedHashMap<String,Object>();for (int index = 0; index < entries.length; index += 2) map.put((String)entries[index], entries[index+1]);return map;
    }
    private static void writeValue(JsonGenerator json, Object value) throws IOException {
        if (value == null) json.writeNull();
        else if (value instanceof String text) json.writeString(text);
        else if (value instanceof Boolean flag) json.writeBoolean(flag);
        else if (value instanceof Number number) json.writeNumber(number.longValue());
        else if (value instanceof Map<?,?> map) {json.writeStartObject();for (var entry : map.entrySet()) {json.writeFieldName((String)entry.getKey());writeValue(json,entry.getValue());}json.writeEndObject();}
        else if (value instanceof List<?> list) {json.writeStartArray();for (Object item : list) writeValue(json,item);json.writeEndArray();}
        else throw new ArtifactException("Unsupported JSON value.");
    }
    private static void writeJson(Path path, Map<String,Object> value, long max) throws IOException {
        try (var file = Files.newOutputStream(path,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS);var bounded = new BoundedOutput(file,max);var json = JSON.createGenerator(bounded)) {writeValue(json,value);json.writeRaw('\n');}
    }
    private static String jsonString(Map<String,Object> value) throws IOException {
        var output = new java.io.ByteArrayOutputStream();try (var json = JSON.createGenerator(output)) {writeValue(json,value);}return output.toString(StandardCharsets.UTF_8);
    }
    static String digest(Path path, long max) throws IOException {
        regularFile(path,max);MessageDigest digest = sha256();long count = 0;byte[] buffer = new byte[262_144];
        try (InputStream input = Files.newInputStream(path,LinkOption.NOFOLLOW_LINKS)) {for (int read; (read = input.read(buffer)) != -1;) {count += read;require(count <= max,"Artifact exceeds its size bound.");digest.update(buffer,0,read);}}
        return HexFormat.of().formatHex(digest.digest());
    }
    private static MessageDigest sha256() {try {return MessageDigest.getInstance("SHA-256");}catch (NoSuchAlgorithmException error) {throw new IllegalStateException("SHA-256 is unavailable.");}}
    private static Path normalized(Path path) throws ArtifactException {require(path != null,"A local path is required.");return path.toAbsolutePath().normalize();}
    private static void rejectSymlinks(Path path) throws IOException {for (Path part = normalized(path); part != null; part = part.getParent()) require(!Files.isSymbolicLink(part),"Symlinks are not allowed in artifact paths.");}
    private static void regularFile(Path path, long max) throws IOException {rejectSymlinks(path);require(Files.isRegularFile(path,LinkOption.NOFOLLOW_LINKS) && Files.size(path) <= max,"Artifact is unavailable or exceeds its size bound.");}
    private static int checkedId(long value,int count) throws ArtifactException {require(value >= 0 && value < count,"Token ID is out of range.");return (int)value;}
    private static long number(Object value) throws ArtifactException {require(value instanceof Long,"Expected an integer.");return (Long)value;}
    private static String text(Object value) throws ArtifactException {require(value instanceof String,"Expected text.");return (String)value;}
    private static void require(boolean condition,String message) throws ArtifactException {if (!condition) throw new ArtifactException(message);}
    private static void deleteStaging(Path directory) throws IOException {
        if (!Files.exists(directory,LinkOption.NOFOLLOW_LINKS)) return;
        try (var files = Files.walk(directory)) {for (Path path : files.sorted(Comparator.reverseOrder()).toList()) Files.delete(path);}
    }

    static final class BoundedOutput extends OutputStream {
        private final OutputStream target;private final long max;private long count;
        BoundedOutput(OutputStream target,long max) {this.target=target;this.max=max;}
        @Override public void write(int value) throws IOException {require(count < max,"Artifact exceeds its size bound.");target.write(value);count++;}
        @Override public void write(byte[] bytes,int offset,int length) throws IOException {require(length >= 0 && count <= max - length,"Artifact exceeds its size bound.");target.write(bytes,offset,length);count+=length;}
        @Override public void flush() throws IOException {target.flush();}
        @Override public void close() throws IOException {target.close();}
    }

    static final class GgufReader implements AutoCloseable {
        private final FileChannel channel;private final long size;
        GgufReader(Path path) throws IOException {regularFile(path,MODEL_BYTES);channel=FileChannel.open(path,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS);size=channel.size();}
        private ByteBuffer bytes(int count) throws IOException {
            require(count >= 0 && channel.position() <= MAX_ARTIFACT - count && channel.position() <= size - count,"Tokenizer header exceeded its bound or is incomplete.");
            ByteBuffer buffer = ByteBuffer.allocate(count).order(ByteOrder.LITTLE_ENDIAN);
            while (buffer.hasRemaining()) require(channel.read(buffer) != -1,"Incomplete GGUF metadata.");buffer.flip();return buffer;
        }
        long u32() throws IOException {return Integer.toUnsignedLong(bytes(4).getInt());}
        long u64() throws IOException {long value=bytes(8).getLong();require(value >= 0,"Invalid metadata size.");return value;}
        int type() throws IOException {long type=u32();require(type <= 12,"Unsupported metadata type.");return (int)type;}
        boolean bool() throws IOException {byte value=bytes(1).get();require(value == 0 || value == 1,"Invalid boolean metadata.");return value == 1;}
        String string() throws IOException {
            long count=u64();require(count <= 1_048_576,"Metadata string exceeds its bound.");
            try {return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(bytes((int)count)).toString();}
            catch (CharacterCodingException error) {throw new ArtifactException("Invalid UTF-8 metadata.");}
        }
        String[] strings() throws IOException {require(type() == 8,"Invalid string-array type.");long count=u64();require(count <= 1_000_000,"Metadata array exceeds its bound.");String[] result=new String[(int)count];for (int index=0;index<result.length;index++) result[index]=string();return result;}
        int[] integers() throws IOException {int type=type();require(type == 4 || type == 5,"Invalid integer-array type.");long count=u64();require(count <= 1_000_000,"Metadata array exceeds its bound.");int[] result=new int[(int)count];ByteBuffer encoded=bytes((int)count*4);for(int index=0;index<result.length;index++){long value=Integer.toUnsignedLong(encoded.getInt());require(value <= Integer.MAX_VALUE,"Invalid token-type value.");result[index]=(int)value;}return result;}
        void skip(int type) throws IOException {
            int width=switch(type){case 0,1,7 -> 1;case 2,3 -> 2;case 4,5,6 -> 4;case 10,11,12 -> 8;case 8,9 -> 0;default -> throw new ArtifactException("Unsupported metadata type.");};
            if(width>0){bytes(width);return;}
            if(type == 8){string();return;}
            int item=type();long count=u64();require(item != 9 && count <= 1_000_000,"Invalid metadata array.");for(long index=0;index<count;index++) skip(item);
        }
        @Override public void close() throws IOException {channel.close();}
    }
}
