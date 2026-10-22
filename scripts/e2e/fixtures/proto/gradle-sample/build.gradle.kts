plugins {
    id("dev.slne.weaver")
}

group = "dev.smoke"
version = "1.0.0"

// WEAVER_URL and WEAVER_TOKEN come from the environment; -PpublishRepository=<name> publishes elsewhere.
weaver {
    repositories("proto-hosted")
    publishing {
        repository.set(providers.gradleProperty("publishRepository").orElse("proto-hosted"))
        group.set("dev.smoke")
        name.set("sample")
    }
}
