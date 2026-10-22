package dev.slne.weaver.gradle

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.artifacts.ArtifactCollection
import org.gradle.api.artifacts.Configuration
import org.gradle.api.artifacts.DependencyScopeConfiguration
import org.gradle.api.artifacts.ProjectDependency
import org.gradle.api.artifacts.component.ProjectComponentIdentifier
import org.gradle.api.artifacts.result.ResolvedArtifactResult
import org.gradle.api.artifacts.type.ArtifactTypeDefinition
import org.gradle.api.attributes.Usage
import org.gradle.api.file.FileCollection
import org.gradle.api.file.RegularFile
import org.gradle.api.provider.Provider
import java.io.File

/**
 * What a module tells the modules that depend on it in the same build: its own publishing
 * coordinate (`null` without a complete `weaver.publishing` block) and its direct external
 * `weaver` dependencies.
 */
@Serializable
internal data class LocalManifest(val coordinate: String?, val external: List<String>)

private val manifestJson = Json { ignoreUnknownKeys = true }

internal fun writeLocalManifest(file: File, manifest: LocalManifest) {
    file.parentFile.mkdirs()
    file.writeText(manifestJson.encodeToString(LocalManifest.serializer(), manifest))
}

internal fun readLocalManifest(file: File): LocalManifest =
    try {
        manifestJson.decodeFromString(LocalManifest.serializer(), file.readText())
    } catch (e: SerializationException) {
        throw GradleException("Invalid weaver module manifest $file: ${e.message}", e)
    } catch (e: IllegalArgumentException) {
        throw GradleException("Invalid weaver module manifest $file: ${e.message}", e)
    }

/**
 * Wires `weaver(project(":x"))` dependencies between modules of the same build.
 *
 * Every project dependency added to `weaver` is mirrored into the `weaverLocalApi` scope.
 * `weaverElements` publishes this module's proto source directory and its [LocalManifest] to
 * other modules, and `weaverLocalClasspath` resolves them (transitively) from the modules this
 * one depends on.
 */
internal class LocalModules(
    private val project: Project,
    weaver: Provider<out DependencyScopeConfiguration>,
    extension: WeaverExtension,
    manifestFile: Provider<out RegularFile>,
) {
    private val localApi = project.configurations.dependencyScope(LOCAL_API) {
        description = "Project dependencies mirrored from the weaver configuration."
    }

    private val classpath = project.configurations.resolvable(LOCAL_CLASSPATH) {
        description = "Proto sources and manifests of the local modules this module depends on."
        extendsFrom(localApi.get())
        protosUsage(this)
    }

    /** Paths of the projects declared directly in `weaver`, such as `:contracts`. */
    val directProjects: Provider<List<String>> =
        weaver.map { configuration -> configuration.dependencies.withType(ProjectDependency::class.java).map { it.path } }

    init {
        weaver.get().dependencies.withType(ProjectDependency::class.java).all {
            localApi.get().dependencies.add(copy())
        }
        project.configurations.consumable(ELEMENTS) {
            description = "This module's proto sources and manifest, for local modules that depend on it."
            extendsFrom(localApi.get())
            protosUsage(this)
            outgoing {
                artifact(manifestFile) { type = MANIFEST_TYPE }
                variants.create("source") {
                    attributes.attribute(ArtifactTypeDefinition.ARTIFACT_TYPE_ATTRIBUTE, SOURCE_TYPE)
                    artifact(extension.publishing.source) { type = SOURCE_TYPE }
                }
            }
        }
    }

    /** Source directories of all local modules this module depends on, directly or transitively. */
    val sources: FileCollection get() = artifacts(SOURCE_TYPE).artifactFiles

    /** Manifests of all local modules this module depends on, directly or transitively. */
    val manifests: FileCollection get() = artifacts(MANIFEST_TYPE).artifactFiles

    /** Absolute path of each resolved source directory → project path of the module it belongs to. */
    val sourceProjects: Provider<Map<String, String>> get() = projectsByFile(artifacts(SOURCE_TYPE))

    /** Absolute path of each resolved manifest → project path of the module it belongs to. */
    val manifestProjects: Provider<Map<String, String>> get() = projectsByFile(artifacts(MANIFEST_TYPE))

    private fun artifacts(type: String): ArtifactCollection =
        classpath.get().incoming.artifactView {
            attributes.attribute(ArtifactTypeDefinition.ARTIFACT_TYPE_ATTRIBUTE, type)
        }.artifacts

    private fun projectsByFile(artifacts: ArtifactCollection): Provider<Map<String, String>> =
        artifacts.resolvedArtifacts.map { results -> results.associate { it.file.absolutePath to projectPathOf(it) } }

    private fun protosUsage(configuration: Configuration) {
        configuration.attributes.attribute(Usage.USAGE_ATTRIBUTE, project.objects.named(Usage::class.java, USAGE))
    }

    companion object {
        const val USAGE = "weaver-protos"
        const val LOCAL_API = "weaverLocalApi"
        const val ELEMENTS = "weaverElements"
        const val LOCAL_CLASSPATH = "weaverLocalClasspath"
        const val SOURCE_TYPE = "weaver-source"
        const val MANIFEST_TYPE = "weaver-manifest"

        private fun projectPathOf(artifact: ResolvedArtifactResult): String =
            (artifact.id.componentIdentifier as? ProjectComponentIdentifier)?.projectPath
                ?: artifact.id.componentIdentifier.displayName
    }
}
