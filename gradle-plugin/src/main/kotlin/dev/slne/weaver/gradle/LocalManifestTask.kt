package dev.slne.weaver.gradle

import org.gradle.api.DefaultTask
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.TaskAction

/**
 * Writes this module's [LocalManifest] (`{ "coordinate": "g:n:v" | null, "external": [...] }`),
 * which `weaverElements` exposes to local modules that depend on this one.
 */
@CacheableTask
abstract class LocalManifestTask : DefaultTask() {
    /** `group:name:version` from `weaver.publishing`; absent when the block is incomplete. */
    @get:Input
    @get:Optional
    abstract val coordinate: Property<String>

    /** This module's direct external `weaver` dependencies (`g:n:v`). */
    @get:Input
    abstract val external: ListProperty<String>

    @get:OutputFile
    abstract val manifestFile: RegularFileProperty

    @TaskAction
    fun write() {
        writeLocalManifest(manifestFile.get().asFile, LocalManifest(coordinate.orNull, external.get()))
    }
}
