package org.offscript.artifacts

import java.nio.file.Path
import java.io.IOException
import scala.util.control.NonFatal

/** Scala owns command orchestration; Java owns bounded streaming metadata I/O. */
object ArtifactTool:
  private val usage = "Use export-tokenizer --model PATH --config PATH --output NEW_DIRECTORY or verify-artifacts --model PATH --config PATH --artifacts DIRECTORY."

  def main(arguments: Array[String]): Unit =
    try
      ArtifactExporter.requirePinnedJava()
      if arguments.isEmpty then throw new IllegalArgumentException(usage)
      val command = arguments.head
      val allowed = command match
        case "export-tokenizer" => Set("--model", "--config", "--output")
        case "verify-artifacts" => Set("--model", "--config", "--artifacts")
        case _ => throw new IllegalArgumentException(usage)
      val options = parse(arguments.tail, allowed)
      val model = Path.of(options("--model"))
      val config = Path.of(options("--config"))
      val result = command match
        case "export-tokenizer" => ArtifactExporter.exportTokenizer(model, config, Path.of(options("--output")))
        case _ => ArtifactExporter.verifyArtifacts(model, config, Path.of(options("--artifacts")))
      println(result)
    catch
      case error: ArtifactExporter.ArtifactException =>
        System.err.println(error.getMessage)
        System.exit(1)
      case error: IllegalArgumentException =>
        System.err.println(usage)
        System.exit(2)
      case _: IOException =>
        System.err.println("Artifact preparation failed; inspect local file availability and permissions. No replacement output is authorized.")
        System.exit(1)
      case NonFatal(_) =>
        System.err.println("Artifact preparation did not complete. No production change was made.")
        System.exit(1)

  private[artifacts] def parse(arguments: Array[String], allowed: Set[String]): Map[String, String] =
    if arguments.length != allowed.size * 2 then throw new IllegalArgumentException(usage)
    arguments.grouped(2).foldLeft(Map.empty[String, String]) { (result, pair) =>
      if !allowed(pair(0)) || result.contains(pair(0)) || pair(1).isEmpty || pair(1).startsWith("--") then
        throw new IllegalArgumentException(usage)
      result.updated(pair(0), pair(1))
    }
