package org.offscript.artifacts

import java.io.{ByteArrayOutputStream, IOException}
import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Path}
import java.nio.file.attribute.PosixFilePermissions
import scala.collection.mutable.ArrayBuffer
import scala.jdk.CollectionConverters.*

/** Executable, dependency-free contract checks; all inputs are synthetic. */
object ArtifactChecks:
  private var passed = 0
  private def check(name: String)(body: => Unit): Unit =
    body
    passed += 1
    println(s"PASS $name")
  private def rejected(body: => Any): Unit =
    var failed = false
    try body
    catch case _: IOException => failed = true
    assert(failed, "Expected bounded artifact rejection")
  private def badArguments(body: => Any): Unit =
    var failed = false
    try body
    catch case _: IllegalArgumentException => failed = true
    assert(failed, "Expected argument rejection")
  private def integer(out: ByteArrayOutputStream, value: Long, count: Int): Unit =
    (0 until count).foreach(index => out.write(((value >>> (index * 8)) & 0xff).toInt))
  private def string(out: ByteArrayOutputStream, value: String): Unit =
    val bytes = value.getBytes(StandardCharsets.UTF_8)
    integer(out, bytes.length, 8)
    out.write(bytes)
  private def header(count: Long): ByteArrayOutputStream =
    val out = new ByteArrayOutputStream()
    out.write("GGUF".getBytes(StandardCharsets.US_ASCII))
    integer(out, 3, 4)
    integer(out, 320, 8)
    integer(out, count, 8)
    out
  private def fixture(vocab: Array[String] = Array("a", "b", "ab", "<|im_end|>", "ե́", "\n", "  "),
                      merges: Array[String] = Array("a b"),
                      kinds: Array[Int] = Array(1, 1, 1, 3, 1, 1, 1),
                      pre: String = "qwen35", bos: Option[Int] = None,
                      bosWithoutId: Boolean = false): Array[Byte] =
    val values = ArrayBuffer.empty[Array[Byte]]
    def field(name: String, kind: Int)(body: ByteArrayOutputStream => Unit): Unit =
      val value = new ByteArrayOutputStream()
      string(value, name)
      integer(value, kind, 4)
      body(value)
      values += value.toByteArray
    field("tokenizer.ggml.model", 8)(out => string(out, "gpt2"))
    field("tokenizer.ggml.pre", 8)(out => string(out, pre))
    field("tokenizer.ggml.tokens", 9) { out =>
      integer(out, 8, 4); integer(out, vocab.length, 8); vocab.foreach(value => string(out, value))
    }
    field("tokenizer.ggml.merges", 9) { out =>
      integer(out, 8, 4); integer(out, merges.length, 8); merges.foreach(value => string(out, value))
    }
    field("tokenizer.ggml.token_type", 9) { out =>
      integer(out, 4, 4); integer(out, kinds.length, 8); kinds.foreach(value => integer(out, value, 4))
    }
    field("tokenizer.ggml.add_bos_token", 7)(out => integer(out, if bos.nonEmpty || bosWithoutId then 1 else 0, 1))
    bos.foreach(value => field("tokenizer.ggml.bos_token_id", 4)(out => integer(out, value, 4)))
    val out = header(values.length)
    values.foreach(out.write)
    out.toByteArray

  def main(arguments: Array[String]): Unit =
    ArtifactExporter.requirePinnedJava()
    val root = Files.createTempDirectory("offscript-jvm-artifact-checks-", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
    def file(name: String, bytes: Array[Byte]): Path =
      val path = root.resolve(name)
      Files.write(path, bytes)
      path
    def text(name: String, value: String): Path = file(name, value.getBytes(StandardCharsets.UTF_8))
    try
      val data = ArtifactExporter.readTokenizer(file("fixture.gguf", fixture()))
      check("little-endian GGUF metadata preserves IDs, Unicode, whitespace and special types") {
        assert(data.vocab().toSeq == Seq("a", "b", "ab", "<|im_end|>", "ե́", "\n", "  "))
        assert(data.merges().toSeq == Seq("a b"))
        assert(data.types()(3) == 3 && !data.addBos() && data.bosId() == null)
      }
      check("the production entry refuses a different vocabulary size") {
        rejected(ArtifactExporter.validateKnownTokenizer(data))
      }
      check("BOS IDs are preserved without inserting normalization") {
        val enabled = ArtifactExporter.readTokenizer(file("bos.gguf", fixture(bos = Some(0))))
        assert(enabled.addBos() && enabled.bosId().intValue() == 0)
        rejected(ArtifactExporter.readTokenizer(file("missing-bos.gguf", fixture(bosWithoutId = true))))
        rejected(ArtifactExporter.readTokenizer(file("range-bos.gguf", fixture(bos = Some(999)))))
      }
      check("duplicate vocabulary, invalid merge membership and wrong pre-tokenization are rejected") {
        rejected(ArtifactExporter.readTokenizer(file("duplicate.gguf", fixture(vocab = Array("a", "a"), merges = Array.empty, kinds = Array(1, 1)))))
        rejected(ArtifactExporter.readTokenizer(file("bad-merge.gguf", fixture(merges = Array("a absent")))))
        rejected(ArtifactExporter.readTokenizer(file("wrong-pre.gguf", fixture(pre = "qwen2"))))
      }
      check("incomplete, over-count and invalid UTF8 headers fail closed") {
        rejected(ArtifactExporter.readTokenizer(file("truncated.gguf", fixture().dropRight(1))))
        rejected(ArtifactExporter.readTokenizer(file("many-fields.gguf", header(10001).toByteArray)))
        val malformed = header(1); integer(malformed, 1, 8); malformed.write(0xff)
        rejected(ArtifactExporter.readTokenizer(file("invalid-utf8.gguf", malformed.toByteArray)))
        val array = header(1); string(array, "tokenizer.ggml.tokens"); integer(array, 9, 4); integer(array, 8, 4); integer(array, 1000001, 8)
        rejected(ArtifactExporter.readTokenizer(file("array-overflow.gguf", array.toByteArray)))
      }
      val tokenizer = root.resolve("tokenizer.json")
      val tokenizerHash = ArtifactExporter.writeTokenizer(tokenizer, data)
      check("streamed JSON verifies semantically and its hash covers actual UTF8 bytes") {
        ArtifactExporter.verifyTokenizer(tokenizer, data)
        assert(tokenizerHash == ArtifactExporter.digest(tokenizer, ArtifactExporter.MAX_ARTIFACT))
        val parsed = ArtifactExporter.readObject(tokenizer, ArtifactExporter.MAX_ARTIFACT)
        assert(parsed.get("normalizer") == null && parsed.get("truncation") == null && parsed.get("padding") == null)
      }
      check("changed vocabulary IDs or ByteLevel behavior are rejected") {
        val original = Files.readString(tokenizer)
        rejected(ArtifactExporter.verifyTokenizer(text("wrong-ids.json", original.replace("\"a\":0", "\"a\":1")), data))
        rejected(ArtifactExporter.verifyTokenizer(text("wrong-bytelevel.json", original.replace("\"use_regex\":false", "\"use_regex\":true")), data))
      }
      check("duplicate JSON fields, extra payloads and symlink input are rejected") {
        rejected(ArtifactExporter.readObject(text("duplicate.json", "{\"schema\":1,\"schema\":1}"), 4096))
        rejected(ArtifactExporter.readObject(text("trailing.json", "{} {}"), 4096))
        val link = root.resolve("linked.json"); Files.createSymbolicLink(link, tokenizer)
        rejected(ArtifactExporter.readObject(link, ArtifactExporter.MAX_ARTIFACT))
      }
      check("output byte bounds abort without writing beyond the allowance") {
        val output = new ByteArrayOutputStream()
        val bounded = new ArtifactExporter.BoundedOutput(output, 3)
        bounded.write(Array[Byte](1, 2, 3))
        rejected(bounded.write(4))
        assert(output.size() == 3)
      }
      val config = text("model.json", s"""{"bytes":${ArtifactExporter.MODEL_BYTES},"sha256":"${ArtifactExporter.MODEL_SHA256}"}""")
      check("a changed model profile or incorrect model bytes cannot publish output") {
        val wrong = text("wrong-profile.json", "{\"bytes\":1,\"sha256\":\"bad\"}")
        rejected(ArtifactExporter.profile(wrong))
        val output = root.resolve("must-not-exist")
        rejected(ArtifactExporter.exportTokenizer(root.resolve("fixture.gguf"), config, output))
        assert(!Files.exists(output))
        assert(!Files.exists(root.resolve(".must-not-exist.offscript-export.lock")))
      }
      check("existing outputs and another invocation's lock are preserved") {
        val existing = root.resolve("existing"); Files.createDirectory(existing); val marker = existing.resolve("keep"); Files.writeString(marker, "unchanged")
        rejected(ArtifactExporter.exportTokenizer(root.resolve("fixture.gguf"), config, existing))
        assert(Files.readString(marker) == "unchanged")
        val lock = root.resolve(".locked.offscript-export.lock"); Files.writeString(lock, "other invocation")
        rejected(ArtifactExporter.exportTokenizer(root.resolve("fixture.gguf"), config, root.resolve("locked")))
        assert(Files.readString(lock) == "other invocation")
      }
      check("Scala command parsing accepts only explicit complete local options") {
        val allowed = Set("--model", "--config", "--output")
        assert(ArtifactTool.parse(Array("--model", "model.gguf", "--config", "model.json", "--output", "new"), allowed)("--output") == "new")
        badArguments(ArtifactTool.parse(Array("--model", "one", "--model", "two", "--output", "new"), allowed))
        badArguments(ArtifactTool.parse(Array("--model", "one", "--config", "config", "--download", "url"), allowed))
        badArguments(ArtifactTool.parse(Array("--model", "one"), allowed))
      }
      println(s"ARTIFACT_CONTRACT_CHECKS=$passed")
    finally
      val paths = Files.walk(root)
      try paths.sorted(java.util.Comparator.reverseOrder[Path]()).iterator().asScala.foreach(path => Files.delete(path))
      finally paths.close()
