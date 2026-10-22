plugins {
    id("dev.slne.weaver")
}

group = "dev.upstream"
// -PsampleVersion=<v> publishes another version (snapshots); -PprotoSource=<dir> another set of files.
version = providers.gradleProperty("sampleVersion").getOrElse("1.0.0")

// Published to the upstream Weaver; WEAVER_URL and WEAVER_TOKEN come from the environment.
weaver {
    publishing {
        repository.set("proto-upstream")
        group.set("dev.upstream")
        name.set("base")
        source.set(file(providers.gradleProperty("protoSource").getOrElse("src/main/proto")))
    }
}
