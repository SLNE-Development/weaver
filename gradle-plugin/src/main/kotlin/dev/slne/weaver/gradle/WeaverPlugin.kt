package dev.slne.weaver.gradle

import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.artifacts.ExternalModuleDependency
import org.gradle.api.tasks.bundling.Compression
import org.gradle.api.tasks.bundling.Tar
import java.io.File

/**
 * Adds the `weaver` extension, the declarable `weaver` configuration for proto dependencies
 * (remote `group:name:version` coordinates and `project(":x")` modules of the same build), and the
 * `fetchProtos` and `publishProtos` tasks.
 */
class WeaverPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val extension = project.extensions.create(EXTENSION, WeaverExtension::class.java)
        extension.url.convention(project.providers.environmentVariable("WEAVER_URL"))
        extension.token.convention(project.providers.environmentVariable("WEAVER_TOKEN"))
        extension.publishing.version.convention(
            project.provider { project.version.toString() }.filter { it != Project.DEFAULT_VERSION },
        )
        extension.publishing.source.convention(project.layout.projectDirectory.dir("src/main/proto"))

        val weaver = project.configurations.dependencyScope(CONFIGURATION) {
            description = "Proto bundles (group:name:version) and local modules to fetch and to declare as dependencies when publishing."
        }
        val externalCoordinates = weaver.map { configuration ->
            configuration.dependencies.withType(ExternalModuleDependency::class.java).map { dependency ->
                externalCoordinate(dependency.group, dependency.name, dependency.version)
            }
        }

        val publishing = extension.publishing
        val localManifest = project.tasks.register("weaverManifest", LocalManifestTask::class.java) {
            description = "Writes the coordinate and external weaver dependencies that dependent local modules read."
            coordinate.set(
                publishing.group.zip(publishing.name) { group, name -> "$group:$name" }
                    .zip(publishing.version) { groupAndName, version -> "$groupAndName:$version" },
            )
            external.set(externalCoordinates)
            manifestFile.set(project.layout.buildDirectory.file("weaver/module.json"))
        }
        val localModules = LocalModules(project, weaver, extension, localManifest.flatMap { it.manifestFile })

        val fetchProtos = project.tasks.register("fetchProtos", FetchProtosTask::class.java) {
            group = TASK_GROUP
            description = "Resolves the weaver dependencies and extracts them into build/weaver/protos."
            url.set(extension.url)
            token.set(extension.token)
            repositories.set(extension.repositories)
            dependencies.set(externalCoordinates)
            localSources.from(localModules.sources)
            localSourceProjects.set(localModules.sourceProjects)
            localManifests.from(localModules.manifests)
            localManifestProjects.set(localModules.manifestProjects)
            cacheDir.set(File(project.gradle.gradleUserHomeDir, "caches/weaver"))
            outputDir.set(project.layout.buildDirectory.dir("weaver/protos"))
        }
        extension.protosDirFrom(fetchProtos.flatMap { it.outputDir })

        val packProtos = project.tasks.register("packProtos", Tar::class.java) {
            group = TASK_GROUP
            description = "Packs the .proto files of weaver.publishing.source into a reproducible tar.gz."
            from(publishing.source) { include(PROTO_PATTERN) }
            includeEmptyDirs = false
            compression = Compression.GZIP
            isPreserveFileTimestamps = false
            isReproducibleFileOrder = true
            destinationDirectory.set(project.layout.buildDirectory.dir("weaver/publish"))
            archiveFileName.set("protos.tar.gz")
        }

        project.tasks.register("publishProtos", PublishProtosTask::class.java) {
            group = TASK_GROUP
            description = "Publishes the .proto files to the Weaver registry."
            url.set(extension.url)
            token.set(extension.token)
            repository.set(publishing.repository)
            snapshotRepository.set(publishing.snapshotRepository)
            artifactGroup.set(publishing.group)
            artifactName.set(publishing.name)
            artifactVersion.set(publishing.version)
            dependencies.set(externalCoordinates)
            projectDependencies.set(localModules.directProjects)
            localManifests.from(localModules.manifests)
            localManifestProjects.set(localModules.manifestProjects)
            sourceDir.set(publishing.source)
            archive.set(packProtos.flatMap { it.archiveFile })
        }
    }

    companion object {
        const val EXTENSION = "weaver"
        const val CONFIGURATION = "weaver"
        const val TASK_GROUP = "weaver"
        internal const val PROTO_PATTERN = "**/*.proto"
    }
}

/** The `group:name:version` of an external `weaver` dependency; group and version are required. */
internal fun externalCoordinate(group: String?, name: String, version: String?): String {
    val checkedVersion = version?.takeIf { it.isNotBlank() }
        ?: throw GradleException("weaver dependency $group:$name needs a version.")
    val checkedGroup = group?.takeIf { it.isNotBlank() }
        ?: throw GradleException("weaver dependency $name:$checkedVersion needs a group (group:name:version).")
    return "$checkedGroup:$name:$checkedVersion"
}
