package dev.slne.weaver.gradle

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.util.Date
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

/** A request the stub captured, with its body. */
internal class CapturedRequest(
    val method: String,
    val path: String,
    val authorization: String?,
    val contentType: String,
    val body: ByteArray,
)

/**
 * A minimal stand-in for the Weaver REST API that records what the plugin sends. `/resolve`
 * answers with [coordinate], whose archive holds [files], and [extraArtifacts], minus the
 * `group:name` keys in the request's `exclude` and whatever is reachable only through them via
 * [artifactDependencies] (unless [ignoreExclude] is set, to mimic an older server).
 */
internal class RegistryStub : AutoCloseable {
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val url: String get() = "http://127.0.0.1:${server.address.port}"

    // Unique per test so the shared TestKit cache never already holds this archive.
    val protoContent = "syntax = \"proto3\";\npackage a.v1;\n// ${UUID.randomUUID()}\n"

    @Volatile var coordinate = "dev.example:a:1.0.0"
    @Volatile var files: Map<String, String> = mapOf("a/v1/a.proto" to protoContent)

    /** Further artifacts `/resolve` returns, coordinate → archive contents. */
    @Volatile var extraArtifacts: Map<String, Map<String, String>> = emptyMap()

    /** Dependency edges between the served artifacts, coordinate -> coordinates it depends on. */
    @Volatile var artifactDependencies: Map<String, List<String>> = emptyMap()

    @Volatile var ignoreExclude = false

    /** Origin written into `archiveUrl`; defaults to this stub's own [url]. */
    @Volatile var archiveOrigin: String? = null

    val resolveBodies = CopyOnWriteArrayList<String>()
    val authorizations = CopyOnWriteArrayList<String?>()
    val archivePaths = CopyOnWriteArrayList<String>()
    val archiveDownloads = AtomicInteger()
    val publishes = CopyOnWriteArrayList<CapturedRequest>()

    /** When set, `/resolve` answers [resolveStatus] with [resolveResponse] instead of the artifacts. */
    @Volatile var resolveStatus = 200
    @Volatile var resolveResponse = ""

    @Volatile var corruptArchive = false
    @Volatile var publishStatus = 201
    @Volatile var publishResponse = """{"coordinate":"dev.example:b:1.0.0","buildNumber":1,"sha256":"00","redeployed":false}"""

    init {
        server.createContext("/api/v1/resolve") { exchange ->
            authorizations += exchange.requestHeaders.getFirst("Authorization")
            val request = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
            resolveBodies += request
            if (resolveStatus != 200) {
                exchange.respond(resolveStatus, "application/json", resolveResponse.toByteArray())
                return@createContext
            }
            val exclude = if (ignoreExclude) {
                emptySet()
            } else {
                Json.parseToJsonElement(request).jsonObject["exclude"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty().toSet()
            }
            val origin = archiveOrigin ?: url
            val artifacts = resolved(exclude).joinToString(",") { (coordinate, files) ->
                val (group, name, version) = coordinate.split(":")
                """
                {"repository":"releases","coordinate":"$coordinate","group":"$group",
                "name":"$name","version":"$version","buildNumber":1,"sha256":"${sha256(tarGz(files))}",
                "archiveUrl":"$origin/api/v1/repos/releases/artifacts/$group/$name/$version/archive"}
                """.trimIndent()
            }
            val body = """{"artifacts":[$artifacts],"conflicts":[]}"""
            exchange.respond(200, "application/json", body.toByteArray())
        }
        server.createContext("/api/v1/repos/") { exchange ->
            when (exchange.requestMethod) {
                "GET" -> {
                    authorizations += exchange.requestHeaders.getFirst("Authorization")
                    archivePaths += exchange.requestURI.path
                    archiveDownloads.incrementAndGet()
                    val (group, name, version) = exchange.requestURI.path.split("/").dropLast(1).takeLast(3)
                    val files = artifacts()["$group:$name:$version"]
                    if (files == null) {
                        exchange.respond(404, "text/plain", ByteArray(0))
                        return@createContext
                    }
                    val archive = tarGz(files)
                    val bytes = if (corruptArchive) tarGz(files.mapValues { "tampered" }) else archive
                    exchange.responseHeaders.add("x-weaver-sha256", sha256(archive))
                    exchange.respond(200, "application/gzip", bytes)
                }
                "PUT" -> {
                    publishes += CapturedRequest(
                        method = exchange.requestMethod,
                        path = exchange.requestURI.path,
                        authorization = exchange.requestHeaders.getFirst("Authorization"),
                        contentType = exchange.requestHeaders.getFirst("Content-Type"),
                        body = exchange.requestBody.readBytes(),
                    )
                    exchange.respond(publishStatus, "application/json", publishResponse.toByteArray())
                }
                else -> exchange.respond(405, "text/plain", ByteArray(0))
            }
        }
        server.start()
    }

    private fun artifacts(): Map<String, Map<String, String>> = mapOf(coordinate to files) + extraArtifacts

    /** Artifacts reachable from those nothing depends on, never entering an excluded `group:name`. */
    private fun resolved(exclude: Set<String>): List<Pair<String, Map<String, String>>> {
        val all = artifacts()
        val dependedOn = artifactDependencies.values.flatten().toSet()
        val reached = linkedSetOf<String>()
        val pending = ArrayDeque(all.keys.filter { it !in dependedOn })
        while (pending.isNotEmpty()) {
            val next = pending.removeFirst()
            if (next.substringBeforeLast(':') in exclude || !reached.add(next)) continue
            pending.addAll(artifactDependencies[next].orEmpty())
        }
        return reached.filter { it in all }.map { it to all.getValue(it) }
    }

    override fun close() = server.stop(0)
}

/** An HTTP server on another port that records every request it receives and answers 404. */
internal class RecordingServer : AutoCloseable {
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val url: String get() = "http://127.0.0.1:${server.address.port}"
    val requests = CopyOnWriteArrayList<String>()
    val authorizations = CopyOnWriteArrayList<String?>()

    init {
        server.createContext("/") { exchange ->
            requests += exchange.requestURI.toString()
            authorizations += exchange.requestHeaders.getFirst("Authorization")
            exchange.respond(404, "text/plain", ByteArray(0))
        }
        server.start()
    }

    override fun close() = server.stop(0)
}

private fun HttpExchange.respond(status: Int, contentType: String, body: ByteArray) {
    responseHeaders.add("Content-Type", contentType)
    sendResponseHeaders(status, if (body.isEmpty()) -1 else body.size.toLong())
    responseBody.use { it.write(body) }
}

private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** Builds a deterministic tar.gz (fixed timestamps), so repeated calls give identical bytes. */
internal fun tarGz(files: Map<String, String>): ByteArray {
    val out = ByteArrayOutputStream()
    TarArchiveOutputStream(GZIPOutputStream(out)).use { tar ->
        files.forEach { (path, content) ->
            val bytes = content.toByteArray()
            tar.putArchiveEntry(
                TarArchiveEntry(path).apply {
                    size = bytes.size.toLong()
                    modTime = Date(0)
                },
            )
            tar.write(bytes)
            tar.closeArchiveEntry()
        }
    }
    return out.toByteArray()
}

internal fun tarEntries(gzipped: ByteArray): List<TarArchiveEntry> =
    TarArchiveInputStream(GZIPInputStream(ByteArrayInputStream(gzipped))).use { tar ->
        generateSequence { tar.nextEntry }.toList()
    }

internal class Part(val bytes: ByteArray) {
    val text: String get() = bytes.toString(Charsets.UTF_8)
}

/** Splits a multipart/form-data body into its parts, keyed by field name. */
internal fun parseMultipart(contentType: String, body: ByteArray): Map<String, Part> {
    val boundary = contentType.substringAfter("boundary=").trim('"')
    val raw = body.toString(Charsets.ISO_8859_1)
    return raw.split("--$boundary")
        .drop(1)
        .filterNot { it.startsWith("--") }
        .associate { section ->
            val headers = section.substringBefore("\r\n\r\n")
            val content = section.substringAfter("\r\n\r\n").removeSuffix("\r\n")
            val name = Regex("name=\"([^\"]+)\"").find(headers)!!.groupValues[1]
            name to Part(content.toByteArray(Charsets.ISO_8859_1))
        }
}
