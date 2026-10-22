package dev.slne.weaver.gradle

import org.gradle.api.Action
import org.gradle.api.file.Directory
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.model.ObjectFactory
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.provider.Provider
import javax.inject.Inject

/** The `weaver {}` block: registry connection, repositories to resolve from, and what to publish. */
abstract class WeaverExtension @Inject constructor(objects: ObjectFactory) {
    /** Base URL of the Weaver server. Defaults to the `WEAVER_URL` environment variable. */
    abstract val url: Property<String>

    /** API key sent as a bearer token. Defaults to the `WEAVER_TOKEN` environment variable. */
    abstract val token: Property<String>

    /** Repositories to resolve dependencies from, in lookup order. */
    abstract val repositories: ListProperty<String>

    /** Settings for `publishProtos`. */
    val publishing: PublishingSpec = objects.newInstance(PublishingSpec::class.java)

    private val protosDirProperty: DirectoryProperty = objects.directoryProperty()

    /** The merged proto root written by `fetchProtos`; consuming it adds the task dependency automatically. */
    val protosDir: Provider<Directory> get() = protosDirProperty

    /** Appends repositories to the lookup order. */
    fun repositories(vararg names: String) {
        repositories.addAll(*names)
    }

    /** Configures [publishing]. */
    fun publishing(action: Action<in PublishingSpec>) {
        action.execute(publishing)
    }

    internal fun protosDirFrom(dir: Provider<Directory>) {
        protosDirProperty.set(dir)
        protosDirProperty.disallowChanges()
    }
}

/** Target coordinates and source directory of the artifact that `publishProtos` uploads. */
abstract class PublishingSpec {
    /** Repository that receives release versions. */
    abstract val repository: Property<String>

    /** Repository that receives `-SNAPSHOT` versions; falls back to [repository] when unset. */
    abstract val snapshotRepository: Property<String>

    abstract val group: Property<String>

    abstract val name: Property<String>

    /** Defaults to `project.version`. */
    abstract val version: Property<String>

    /** Directory holding the `.proto` files. Defaults to `src/main/proto`. */
    abstract val source: DirectoryProperty
}
