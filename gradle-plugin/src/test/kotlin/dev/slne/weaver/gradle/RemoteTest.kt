package dev.slne.weaver.gradle

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RemoteTest {
    @TempDir
    lateinit var projectDir: File

    private lateinit var stub: RegistryStub

    @BeforeEach
    fun startStub() {
        stub = RegistryStub()
    }

    @AfterEach
    fun stopStub() {
        stub.close()
    }

    @Test
    fun `fetchProtos resolves the declared dependencies and extracts them into the proto root`() {
        writeBuild(
            """
            weaver {
                repositories("releases")
            }
            dependencies {
                weaver("dev.example:a:1.0.0")
            }
            """,
        )

        val result = gradle("fetchProtos").build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":fetchProtos")?.outcome)
        assertEquals(1, stub.resolveBodies.size)
        assertEquals(
            Json.parseToJsonElement("""{"repositories":["releases"],"dependencies":["dev.example:a:1.0.0"]}"""),
            Json.parseToJsonElement(stub.resolveBodies.single()),
        )
        assertEquals(stub.protoContent, projectDir.resolve("build/weaver/protos/a/v1/a.proto").readText())
        assertEquals(listOf("Bearer secret-token", "Bearer secret-token"), stub.authorizations.toList())
    }

    @Test
    fun `a second fetch reuses the cached archive`() {
        writeBuild(
            """
            weaver {
                repositories("releases")
            }
            dependencies {
                weaver("dev.example:a:1.0.0")
            }
            """,
        )

        gradle("fetchProtos").build()
        projectDir.resolve("build/weaver/protos/a/v1/a.proto").delete()
        val second = gradle("fetchProtos").build()

        assertTrue(second.output.contains("Reusing configuration cache"), second.output)
        assertEquals(2, stub.resolveBodies.size)
        assertEquals(1, stub.archiveDownloads.get())
        assertEquals(stub.protoContent, projectDir.resolve("build/weaver/protos/a/v1/a.proto").readText())
    }

    @Test
    fun `fetchProtos rejects an archive whose checksum differs from the resolved one`() {
        stub.corruptArchive = true
        writeBuild(
            """
            weaver {
                repositories("releases")
            }
            dependencies {
                weaver("dev.example:a:1.0.0")
            }
            """,
        )

        val result = gradle("fetchProtos").buildAndFail()

        assertTrue(result.output.contains("Checksum mismatch for dev.example:a:1.0.0"), result.output)
        assertFalse(projectDir.resolve("build/weaver/protos/a/v1/a.proto").exists())
    }

    @Test
    fun `protosDir carries the fetchProtos task dependency`() {
        writeBuild(
            """
            weaver {
                repositories("releases")
            }
            dependencies {
                weaver("dev.example:a:1.0.0")
            }

            abstract class ReadProtos : DefaultTask() {
                @get:InputDirectory
                abstract val protos: DirectoryProperty

                @TaskAction
                fun read() {
                    println("read: " + protos.get().file("a/v1/a.proto").asFile.readText())
                }
            }

            tasks.register<ReadProtos>("readProtos") {
                protos.set(weaver.protosDir)
            }
            """,
        )

        val result = gradle("readProtos").build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":fetchProtos")?.outcome)
        assertTrue(result.output.contains("read: ${stub.protoContent}"), result.output)
    }

    @Test
    fun `publishProtos uploads the manifest and an archive with only the proto files`() {
        writeProtoSources()
        writeBuild(
            """
            weaver {
                publishing {
                    repository = "releases"
                    group = "dev.example"
                    name = "b"
                    version = "1.0.0"
                }
            }
            dependencies {
                weaver("dev.example:a:1.0.0")
            }
            """,
        )

        val result = gradle("publishProtos").build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":publishProtos")?.outcome)
        val publish = stub.publishes.single()
        assertEquals("PUT", publish.method)
        assertEquals("/api/v1/repos/releases/artifacts/dev.example/b/1.0.0", publish.path)
        assertEquals("Bearer secret-token", publish.authorization)
        val parts = parseMultipart(publish.contentType, publish.body)
        val manifest = buildJsonObject {
            put("group", "dev.example")
            put("name", "b")
            put("version", "1.0.0")
            putJsonArray("dependencies") { add(JsonPrimitive("dev.example:a:1.0.0")) }
        }
        assertEquals<JsonElement>(manifest, Json.parseToJsonElement(parts.getValue("manifest").text))
        val archiveFiles = tarEntries(parts.getValue("archive").bytes).filter { it.isFile }.map { it.name }
        assertEquals(listOf("b/v1/b.proto", "b/v1/c.proto"), archiveFiles.sorted())
        assertTrue(result.output.contains("Published dev.example:b:1.0.0 to releases"), result.output)
    }

    @Test
    fun `publishProtos sends snapshot versions to the snapshot repository`() {
        writeProtoSources()
        writeBuild(
            """
            version = "1.1.0-SNAPSHOT"
            weaver {
                publishing {
                    repository = "releases"
                    snapshotRepository = "snapshots"
                    group = "dev.example"
                    name = "b"
                }
            }
            """,
        )

        gradle("publishProtos").build()

        val publish = stub.publishes.single()
        assertEquals("/api/v1/repos/snapshots/artifacts/dev.example/b/1.1.0-SNAPSHOT", publish.path)
        val manifest = Json.parseToJsonElement(parseMultipart(publish.contentType, publish.body).getValue("manifest").text)
        assertEquals(JsonArray(emptyList()), (manifest as JsonObject).getValue("dependencies"))
    }

    @Test
    fun `a rejected publish fails the build with the registry error`() {
        stub.publishStatus = 409
        stub.publishResponse = """{"error":{"code":"immutable","message":"dev.example:b:1.0.0 already exists"}}"""
        writeProtoSources()
        writeBuild(
            """
            weaver {
                publishing {
                    repository = "releases"
                    group = "dev.example"
                    name = "b"
                    version = "1.0.0"
                }
            }
            """,
        )

        val result = gradle("publishProtos").buildAndFail()

        assertTrue(result.output.contains("immutable: dev.example:b:1.0.0 already exists"), result.output)
    }

    @Test
    fun `fetchProtos surfaces a 502 message`() {
        stub.resolveStatus = 502
        stub.resolveResponse = """{"error":{"code":"upstream_unavailable","message":"Upstream of up-mirror did not answer"}}"""
        writeBuild(
            """
            weaver {
                repositories("up-mirror")
            }
            dependencies {
                weaver("dev.example:a:1.0.0")
            }
            """,
        )

        val result = gradle("fetchProtos").buildAndFail()

        assertTrue(result.output.contains("Upstream of up-mirror did not answer"), result.output)
    }

    @Test
    fun `a missing registry url names WEAVER_URL`() {
        writeBuild(
            """
            weaver {
                repositories("releases")
            }
            dependencies {
                weaver("dev.example:a:1.0.0")
            }
            """,
        )

        val result = gradle("fetchProtos", env = System.getenv() - "WEAVER_URL" - "WEAVER_TOKEN").buildAndFail()

        assertTrue(result.output.contains("WEAVER_URL"), result.output)
        assertEquals(0, stub.resolveBodies.size)
    }

    @Test
    fun `an archiveUrl on another origin is rebased onto weaver url and never receives the token`() {
        RecordingServer().use { foreign ->
            stub.archiveOrigin = foreign.url
            writeBuild(
                """
                weaver {
                    repositories("releases")
                }
                dependencies {
                    weaver("dev.example:a:1.0.0")
                }
                """,
            )

            gradle("fetchProtos").build()

            assertEquals(emptyList(), foreign.requests.toList())
            assertEquals(listOf("/api/v1/repos/releases/artifacts/dev.example/a/1.0.0/archive"), stub.archivePaths.toList())
            assertEquals(listOf("Bearer secret-token", "Bearer secret-token"), stub.authorizations.toList())
            assertEquals(stub.protoContent, projectDir.resolve("build/weaver/protos/a/v1/a.proto").readText())
        }
    }

    @Test
    fun `fetchProtos removes stale files from the proto root`() {
        writeBuild(
            """
            weaver {
                repositories("releases")
            }
            dependencies {
                weaver("dev.example:a:1.0.0")
            }
            """,
        )
        val stale = projectDir.resolve("build/weaver/protos/old/x.proto")
        stale.parentFile.mkdirs()
        stale.writeText("syntax = \"proto3\";\n")

        gradle("fetchProtos").build()

        assertFalse(stale.exists())
        assertTrue(projectDir.resolve("build/weaver/protos/a/v1/a.proto").isFile)
    }

    @Test
    fun `publishProtos without proto files fails naming the source directory`() {
        projectDir.resolve("protos").mkdirs()
        projectDir.resolve("protos/README.md").writeText("no protos here")
        writeBuild(
            """
            weaver {
                publishing {
                    repository = "releases"
                    group = "dev.example"
                    name = "b"
                    version = "1.0.0"
                    source = layout.projectDirectory.dir("protos")
                }
            }
            """,
        )

        val result = gradle("publishProtos").buildAndFail()

        val sourceDir = projectDir.resolve("protos")
        val named = listOf(sourceDir.absolutePath, sourceDir.canonicalPath).any { result.output.contains("No .proto files found in $it") }
        assertTrue(named, result.output)
        assertEquals(0, stub.publishes.size)
    }

    private fun writeBuild(body: String) {
        projectDir.resolve("settings.gradle.kts").writeText("""rootProject.name = "consumer"""" + "\n")
        projectDir.resolve("build.gradle.kts").writeText(
            "plugins {\n    id(\"dev.slne.weaver\")\n}\n" + body.trimIndent() + "\n",
        )
    }

    private fun writeProtoSources() {
        val root = projectDir.resolve("src/main/proto/b/v1").apply { mkdirs() }
        root.resolve("b.proto").writeText("syntax = \"proto3\";\npackage b.v1;\n")
        root.resolve("c.proto").writeText("syntax = \"proto3\";\npackage b.v1;\n")
        root.resolve("README.md").writeText("not a proto")
        projectDir.resolve("src/main/proto/notes.txt").writeText("not a proto either")
    }

    private fun gradle(
        vararg tasks: String,
        env: Map<String, String> = System.getenv() + mapOf("WEAVER_URL" to stub.url, "WEAVER_TOKEN" to "secret-token"),
    ): GradleRunner = GradleRunner.create()
        .withProjectDir(projectDir)
        .withPluginClasspath()
        .withEnvironment(env)
        .withArguments(*tasks, "--configuration-cache", "--stacktrace")
        .forwardOutput()
}
