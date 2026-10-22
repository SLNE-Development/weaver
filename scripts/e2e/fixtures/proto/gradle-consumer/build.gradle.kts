plugins {
    id("dev.slne.weaver")
}

// Fetches proto dependencies with `fetchProtos` into build/weaver/protos. WEAVER_URL and WEAVER_TOKEN
// come from the environment; -PweaverRepositories and -PweaverDependencies (comma-separated) pick what.
weaver {
    repositories(*providers.gradleProperty("weaverRepositories").getOrElse("proto-hosted").split(",").toTypedArray())
}

dependencies {
    providers.gradleProperty("weaverDependencies").getOrElse("dev.smoke:sample:1.0.0").split(",").forEach { add("weaver", it) }
}
