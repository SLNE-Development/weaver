package dev.slne.weaver.gradle

import com.sun.net.httpserver.HttpServer
import org.gradle.api.GradleException
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.net.InetSocketAddress
import java.net.URI
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class WeaverClientTest {
    private val client = WeaverClient("https://registry.example.com", "token")

    @Test
    fun `an explicit 443 is the same origin as the default https port`() {
        val archive = "https://registry.example.com:443/api/v1/repos/releases/artifacts/g/n/1.0.0/archive"

        assertEquals(URI.create(archive), client.archiveUri(archive))
    }

    @Test
    fun `another port is a different origin and is rebased onto the configured url`() {
        val archive = "https://registry.example.com:8443/api/v1/repos/releases/artifacts/g/n/1.0.0/archive"

        assertEquals(
            URI.create("https://registry.example.com/api/v1/repos/releases/artifacts/g/n/1.0.0/archive"),
            client.archiveUri(archive),
        )
    }

    @TempDir
    lateinit var tmp: File

    /** Publishes against a server that answers every request with [status] and [body]. */
    private fun publishAgainst(status: Int, body: String): GradleException {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            exchange.requestBody.readBytes()
            val bytes = body.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val archive = File(tmp, "a.tar.gz").apply { writeBytes(byteArrayOf(1, 2, 3)) }
            val client = WeaverClient("http://127.0.0.1:${server.address.port}", "token")
            return assertFailsWith<GradleException> {
                client.publish("releases", Manifest("dev.surf.protection", "protection-contracts", "2.0.0", emptyList()), archive)
            }
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `validation failures list every issue on its own indented line`() {
        val body = """
            {"error":{"code":"validation_failed","message":"Proto validation failed","details":{"issues":[
              {"path":"surf/protection/v1/region.proto","line":5,"column":1,"message":"import \"surf/economy/v1/money.proto\": file does not exist"},
              {"path":"surf/protection/v1/zone.proto","message":"in dependency: syntax error"}
            ]}}}
        """.trimIndent()

        val error = publishAgainst(422, body)

        assertEquals(
            "validation_failed: Proto validation failed\n" +
                "  surf/protection/v1/region.proto:5: import \"surf/economy/v1/money.proto\": file does not exist\n" +
                "  surf/protection/v1/zone.proto: in dependency: syntax error",
            error.message,
        )
    }

    @Test
    fun `at most 20 issues are listed, followed by a count of the rest`() {
        val issues = (1..25).joinToString(",") { """{"path":"f$it.proto","line":$it,"message":"bad $it"}""" }
        val body = """{"error":{"code":"validation_failed","message":"Proto validation failed","details":{"issues":[$issues]}}}"""

        val lines = publishAgainst(422, body).message!!.lines()

        assertEquals(22, lines.size)
        assertEquals("  f1.proto:1: bad 1", lines[1])
        assertEquals("  f20.proto:20: bad 20", lines[20])
        assertEquals("  … and 5 more", lines[21])
    }

    @Test
    fun `control characters and ANSI escapes are stripped from issue paths and messages`() {
        val body = """
            {"error":{"code":"validation_failed","message":"Proto validation failed","details":{"issues":[
              {"path":"a\u001b[31m.proto\u0007","line":2,"message":"red\u001b[0m text\r\nInjected: line\u009b1m"}
            ]}}}
        """.trimIndent()

        val error = publishAgainst(422, body)

        assertEquals("validation_failed: Proto validation failed\n  a.proto:2: red text Injected: line", error.message)
    }

    @Test
    fun `plain http requests never ask for an h2c upgrade, which the Next js server answers by closing the connection`() {
        val upgrades = mutableListOf<String?>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            upgrades += exchange.requestHeaders.getFirst("Upgrade")
            exchange.requestBody.readBytes()
            val bytes = """{"artifacts":[]}""".toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            WeaverClient("http://127.0.0.1:${server.address.port}", "token").resolve(listOf("releases"), emptyList())
        } finally {
            server.stop(0)
        }

        assertEquals(listOf<String?>(null), upgrades)
    }

    @Test
    fun `other errors keep the single-line code and message`() {
        val error = publishAgainst(409, """{"error":{"code":"immutable","message":"already exists","details":{"x":1}}}""")

        assertEquals("immutable: already exists", error.message)
    }
}
