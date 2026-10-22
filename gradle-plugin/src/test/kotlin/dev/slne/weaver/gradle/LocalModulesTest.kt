package dev.slne.weaver.gradle

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Multi-project builds where `:service` declares `weaver(project(":contracts"))` and `:contracts`
 * depends on the remote `dev.example:remote:1.0.0`.
 */
class LocalModulesTest {
    @TempDir
    lateinit var projectDir: File

    private lateinit var stub: RegistryStub

    private val remoteContent = "syntax = \"proto3\";\npackage remote.v1;\n// ${UUID.randomUUID()}\n"

    @BeforeEach
    fun startStub() {
        stub = RegistryStub()
        stub.coordinate = "dev.example:remote:1.0.0"
        stub.files = mapOf("remote/v1/remote.proto" to remoteContent)
    }

    @AfterEach
    fun stopStub() {
        stub.close()
    }

    @Test
    fun `fetchProtos merges the local module's protos with its remote dependencies`() {
        writeProjects()

        val result = gradle(":service:fetchProtos").build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":service:fetchProtos")?.outcome)
        assertEquals(
            Json.parseToJsonElement(
                """{"repositories":["releases"],"dependencies":["dev.example:remote:1.0.0"],"exclude":["dev.example:contracts"]}""",
            ),
            Json.parseToJsonElement(stub.resolveBodies.single()),
        )
        val protos = projectDir.resolve("service/build/weaver/protos")
        assertEquals(CONTRACTS_PROTO, protos.resolve("contracts/v1/a.proto").readText())
        assertEquals(remoteContent, protos.resolve("remote/v1/remote.proto").readText())
        assertEquals(
            listOf("contracts/v1/a.proto", "remote/v1/remote.proto"),
            protos.walk().filter { it.isFile }.map { it.relativeTo(protos).invariantSeparatorsPath }.sorted().toList(),
        )
    }

    @Test
    fun `fetchProtos picks up edits in the local module on the next run`() {
        writeProjects()
        gradle(":service:fetchProtos").build()

        val edited = "syntax = \"proto3\";\npackage contracts.v1;\nmessage Edited {}\n"
        projectDir.resolve("contracts/src/main/proto/contracts/v1/a.proto").writeText(edited)
        val second = gradle(":service:fetchProtos").build()

        assertTrue(second.output.contains("Reusing configuration cache"), second.output)
        assertEquals(edited, projectDir.resolve("service/build/weaver/protos/contracts/v1/a.proto").readText())
    }

    @Test
    fun `fetchProtos needs no registry when the local modules have no remote dependencies`() {
        writeProjects(contractsDependencies = "")

        val result = gradle(":service:fetchProtos", env = System.getenv() - "WEAVER_URL" - "WEAVER_TOKEN").build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":service:fetchProtos")?.outcome)
        assertEquals(CONTRACTS_PROTO, projectDir.resolve("service/build/weaver/protos/contracts/v1/a.proto").readText())
        assertEquals(0, stub.resolveBodies.size)
    }

    @Test
    fun `local modules flow through transitively while publish declares only direct ones`() {
        writeProjects()
        projectDir.resolve("settings.gradle.kts").appendText("include(\":app\")\n")
        projectDir.resolve("app/src/main/proto/app/v1").mkdirs()
        projectDir.resolve("app/src/main/proto/app/v1/app.proto").writeText("syntax = \"proto3\";\n")
        projectDir.resolve("app/build.gradle.kts").writeText(
            """
            plugins {
                id("dev.slne.weaver")
            }
            weaver {
                repositories("releases")
                publishing {
                    repository = "releases"
                    group = "dev.example"
                    name = "app"
                    version = "1.0.0"
                }
            }
            dependencies {
                weaver(project(":service"))
            }
            """.trimIndent() + "\n",
        )

        gradle(":app:fetchProtos", ":app:publishProtos").build()

        assertEquals(
            Json.parseToJsonElement(
                """{"repositories":["releases"],"dependencies":["dev.example:remote:1.0.0"],""" +
                    """"exclude":["dev.example:contracts","dev.example:service"]}""",
            ),
            Json.parseToJsonElement(stub.resolveBodies.single()),
        )
        assertEquals(CONTRACTS_PROTO, projectDir.resolve("app/build/weaver/protos/contracts/v1/a.proto").readText())
        assertEquals(remoteContent, projectDir.resolve("app/build/weaver/protos/remote/v1/remote.proto").readText())
        val publish = stub.publishes.single()
        val manifest = Json.parseToJsonElement(parseMultipart(publish.contentType, publish.body).getValue("manifest").text)
        assertEquals(JsonArray(listOf(JsonPrimitive("dev.example:service:1.0.0"))), (manifest as JsonObject).getValue("dependencies"))
    }

    @Test
    fun `a path provided by both a local module and a remote artifact fails naming both`() {
        stub.files = mapOf("contracts/v1/a.proto" to remoteContent)
        writeProjects()

        val result = gradle(":service:fetchProtos").buildAndFail()

        assertTrue(
            result.output.contains("File contracts/v1/a.proto is provided by both project :contracts and dev.example:remote:1.0.0"),
            result.output,
        )
    }

    @Test
    fun `fetchProtos excludes local modules from resolution so their remote dependencies stay out`() {
        // dev.example:x:1.0.0 -> dev.example:contracts:1.0.0 (which is :contracts here) -> dev.example:legacy:1.0.0
        stub.coordinate = "dev.example:x:1.0.0"
        stub.files = mapOf("x/v1/x.proto" to remoteContent)
        stub.extraArtifacts = mapOf(
            "dev.example:contracts:1.0.0" to mapOf("contracts/v1/a.proto" to "// remote copy\n"),
            "dev.example:legacy:1.0.0" to mapOf("legacy/v1/legacy.proto" to "// legacy\n"),
        )
        stub.artifactDependencies = mapOf(
            "dev.example:x:1.0.0" to listOf("dev.example:contracts:1.0.0"),
            "dev.example:contracts:1.0.0" to listOf("dev.example:legacy:1.0.0"),
        )
        writeProjects(contractsDependencies = "")
        projectDir.resolve("service/build.gradle.kts").appendText("dependencies {\n    weaver(\"dev.example:x:1.0.0\")\n}\n")

        val result = gradle(":service:fetchProtos").build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":service:fetchProtos")?.outcome)
        assertEquals(
            Json.parseToJsonElement(
                """{"repositories":["releases"],"dependencies":["dev.example:x:1.0.0"],"exclude":["dev.example:contracts"]}""",
            ),
            Json.parseToJsonElement(stub.resolveBodies.single()),
        )
        assertEquals(listOf("/api/v1/repos/releases/artifacts/dev.example/x/1.0.0/archive"), stub.archivePaths.toList())
        val protos = projectDir.resolve("service/build/weaver/protos")
        assertEquals(
            listOf("contracts/v1/a.proto", "x/v1/x.proto"),
            protos.walk().filter { it.isFile }.map { it.relativeTo(protos).invariantSeparatorsPath }.sorted().toList(),
        )
        assertEquals(CONTRACTS_PROTO, protos.resolve("contracts/v1/a.proto").readText())
    }

    @Test
    fun `two local modules publishing the same group and name fail naming both`() {
        writeProjects(contractsDependencies = "")
        projectDir.resolve("settings.gradle.kts").appendText("include(\":contracts2\")\n")
        projectDir.resolve("contracts2/src/main/proto/other/v1").mkdirs()
        projectDir.resolve("contracts2/src/main/proto/other/v1/b.proto").writeText("syntax = \"proto3\";\n")
        projectDir.resolve("contracts2/build.gradle.kts").writeText(
            projectDir.resolve("contracts/build.gradle.kts").readText(),
        )
        projectDir.resolve("service/build.gradle.kts").appendText(
            "dependencies {\n    weaver(project(\":contracts2\"))\n    weaver(\"dev.example:x:1.0.0\")\n}\n",
        )

        val result = gradle(":service:fetchProtos").buildAndFail()

        assertTrue(result.output.contains("Projects :contracts and :contracts2 both publish dev.example:contracts"), result.output)
        assertEquals(0, stub.resolveBodies.size)
    }

    @Test
    fun `the client drops a local module's artifact when the server ignores exclude`() {
        stub.ignoreExclude = true
        stub.coordinate = "dev.example:x:1.0.0"
        stub.files = mapOf("x/v1/x.proto" to remoteContent)
        stub.extraArtifacts = mapOf("dev.example:contracts:1.0.0" to mapOf("contracts/v1/a.proto" to "// remote copy\n"))
        writeProjects(contractsDependencies = "")
        projectDir.resolve("service/build.gradle.kts").appendText("dependencies {\n    weaver(\"dev.example:x:1.0.0\")\n}\n")

        val result = gradle(":service:fetchProtos", "--info").build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":service:fetchProtos")?.outcome)
        assertEquals(listOf("/api/v1/repos/releases/artifacts/dev.example/x/1.0.0/archive"), stub.archivePaths.toList())
        assertEquals(1, Regex("Using project :contracts instead of dev.example:contracts:1.0.0").findAll(result.output).count(), result.output)
        val protos = projectDir.resolve("service/build/weaver/protos")
        assertEquals(CONTRACTS_PROTO, protos.resolve("contracts/v1/a.proto").readText())
        assertEquals(remoteContent, protos.resolve("x/v1/x.proto").readText())
    }

    @Test
    fun `a remote artifact with another name still collides with a local module`() {
        stub.coordinate = "dev.example:x:1.0.0"
        stub.files = mapOf("x/v1/x.proto" to remoteContent, "contracts/v1/a.proto" to "// x's copy\n")
        stub.extraArtifacts = mapOf("dev.example:contracts:1.0.0" to mapOf("contracts/v1/a.proto" to "// remote copy\n"))
        writeProjects(contractsDependencies = "")
        projectDir.resolve("service/build.gradle.kts").appendText("dependencies {\n    weaver(\"dev.example:x:1.0.0\")\n}\n")

        val result = gradle(":service:fetchProtos").buildAndFail()

        assertTrue(
            result.output.contains("File contracts/v1/a.proto is provided by both project :contracts and dev.example:x:1.0.0"),
            result.output,
        )
    }

    @Test
    fun `publishProtos declares the local module by its publishing coordinates`() {
        writeProjects()
        projectDir.resolve("service/src/main/proto/service/v1").mkdirs()
        projectDir.resolve("service/src/main/proto/service/v1/s.proto").writeText("syntax = \"proto3\";\n")

        val result = gradle(":service:publishProtos").build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":service:publishProtos")?.outcome)
        val publish = stub.publishes.single()
        assertEquals("/api/v1/repos/releases/artifacts/dev.example/service/1.0.0", publish.path)
        val manifest = Json.parseToJsonElement(parseMultipart(publish.contentType, publish.body).getValue("manifest").text)
        assertEquals(JsonArray(listOf(JsonPrimitive("dev.example:contracts:1.0.0"))), (manifest as JsonObject).getValue("dependencies"))
        assertEquals(listOf("service/v1/s.proto"), tarEntries(parseMultipart(publish.contentType, publish.body).getValue("archive").bytes).filter { it.isFile }.map { it.name })
    }

    @Test
    fun `publishProtos fails when the local module has no publishing block`() {
        writeProjects(contractsPublishing = "")
        projectDir.resolve("service/src/main/proto/service/v1").mkdirs()
        projectDir.resolve("service/src/main/proto/service/v1/s.proto").writeText("syntax = \"proto3\";\n")

        val result = gradle(":service:publishProtos").buildAndFail()

        assertTrue(result.output.contains("Module :contracts has no weaver.publishing block"), result.output)
        assertEquals(0, stub.publishes.size)
    }

    private fun writeProjects(
        contractsDependencies: String = """weaver("dev.example:remote:1.0.0")""",
        contractsPublishing: String = """
            publishing {
                repository = "releases"
                group = "dev.example"
                name = "contracts"
                version = "1.0.0"
            }
        """,
    ) {
        projectDir.resolve("settings.gradle.kts").writeText(
            """
            rootProject.name = "multi"
            include(":contracts", ":service")
            """.trimIndent() + "\n",
        )
        projectDir.resolve("contracts/src/main/proto/contracts/v1").mkdirs()
        projectDir.resolve("contracts/src/main/proto/contracts/v1/a.proto").writeText(CONTRACTS_PROTO)
        projectDir.resolve("contracts/src/main/proto/contracts/v1/notes.txt").writeText("not a proto")
        projectDir.resolve("contracts/build.gradle.kts").writeText(
            "plugins {\n    id(\"dev.slne.weaver\")\n}\n" +
                "weaver {\n    repositories(\"releases\")\n${contractsPublishing.trimIndent()}\n}\n" +
                "dependencies {\n    $contractsDependencies\n}\n",
        )
        projectDir.resolve("service").mkdirs()
        projectDir.resolve("service/build.gradle.kts").writeText(
            """
            plugins {
                id("dev.slne.weaver")
            }
            weaver {
                repositories("releases")
                publishing {
                    repository = "releases"
                    group = "dev.example"
                    name = "service"
                    version = "1.0.0"
                }
            }
            dependencies {
                weaver(project(":contracts"))
            }
            """.trimIndent() + "\n",
        )
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

    private companion object {
        const val CONTRACTS_PROTO = "syntax = \"proto3\";\npackage contracts.v1;\n"
    }
}
