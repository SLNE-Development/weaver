package dev.slne.weaver.gradle

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ArchiveOperations
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.MapProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.work.DisableCachingByDefault
import java.io.File
import javax.inject.Inject

/**
 * Uploads the packed `.proto` archive with a manifest built from `weaver.publishing` and the
 * `weaver` dependencies; a local module dependency is declared by its own publishing coordinate.
 * `-SNAPSHOT` versions go to the snapshot repository when one is set.
 */
@DisableCachingByDefault(because = "Uploads to a remote registry")
abstract class PublishProtosTask : DefaultTask() {
    @get:Input
    @get:Optional
    abstract val url: Property<String>

    @get:Internal
    abstract val token: Property<String>

    @get:Input
    @get:Optional
    abstract val repository: Property<String>

    @get:Input
    @get:Optional
    abstract val snapshotRepository: Property<String>

    @get:Input
    @get:Optional
    abstract val artifactGroup: Property<String>

    @get:Input
    @get:Optional
    abstract val artifactName: Property<String>

    @get:Input
    @get:Optional
    abstract val artifactVersion: Property<String>

    /** Declared external dependencies (`g:n:v`) written into the manifest. */
    @get:Input
    abstract val dependencies: ListProperty<String>

    /** Paths of the local modules declared directly in `weaver`, such as `:contracts`. */
    @get:Input
    abstract val projectDependencies: ListProperty<String>

    /** [LocalManifest]s of the local modules this module depends on, directly or transitively. */
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val localManifests: ConfigurableFileCollection

    /** Absolute path of each [localManifests] file → project path of its module. */
    @get:Internal
    abstract val localManifestProjects: MapProperty<String, String>

    /** `weaver.publishing.source`, checked for `.proto` files before uploading. */
    @get:Internal
    abstract val sourceDir: DirectoryProperty

    /**
     * The tar.gz produced by `packProtos`. Declared as [InputFiles] rather than an input file because
     * `packProtos` produces nothing without `.proto` files, and [publish] reports that case itself.
     */
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val archive: RegularFileProperty

    @get:Inject
    protected abstract val archiveOperations: ArchiveOperations

    @TaskAction
    fun publish() {
        val version = required(artifactVersion, "version")
        val manifest = Manifest(
            group = required(artifactGroup, "group"),
            name = required(artifactName, "name"),
            version = version,
            dependencies = (dependencies.get() + localCoordinates()).distinct(),
        )
        val target = if (version.endsWith("-SNAPSHOT")) {
            snapshotRepository.orNull ?: required(repository, "repository")
        } else {
            required(repository, "repository")
        }
        val source = sourceDir.get().asFile
        val archiveFile = archive.get().asFile
        if (!archiveFile.isFile || archiveOperations.tarTree(archiveOperations.gzip(archiveFile)).isEmpty) {
            throw GradleException("No .proto files found in $source (weaver.publishing.source).")
        }

        val client = weaverClient(url.orNull, token.orNull)
        val result = client.publish(target, manifest, archiveFile)
        val redeployed = if (result.redeployed) " (redeployed)" else ""
        logger.lifecycle("Published ${result.coordinate} to $target, build ${result.buildNumber}$redeployed")
    }

    /** The publishing coordinate of each direct local module, read from its manifest. */
    private fun localCoordinates(): List<String> {
        val manifestByProject = localManifestProjects.get().entries.associate { (file, project) -> project to File(file) }
        return projectDependencies.get().map { path ->
            val manifest = manifestByProject[path]
                ?: throw GradleException("Module $path does not provide a weaver manifest. Apply the dev.slne.weaver plugin to it.")
            readLocalManifest(manifest).coordinate
                ?: throw GradleException("Module $path has no weaver.publishing block (group, name and version) to publish it under.")
        }
    }

    private fun required(property: Property<String>, name: String): String =
        property.orNull?.takeIf { it.isNotBlank() }
            ?: throw GradleException("weaver.publishing.$name is not set.")
}
