plugins {
    `kotlin-dsl`
    `maven-publish`
    kotlin("plugin.serialization") version embeddedKotlinVersion
}

group = "dev.slne.weaver"
version = "0.1.0"

repositories {
    mavenCentral()
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")

    testImplementation(platform("org.junit:junit-bom:6.1.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation(kotlin("test-junit5"))
    testImplementation("org.apache.commons:commons-compress:1.28.0")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

gradlePlugin {
    plugins {
        create("weaver") {
            id = "dev.slne.weaver"
            implementationClass = "dev.slne.weaver.gradle.WeaverPlugin"
            displayName = "Weaver"
            description = "Publishes .proto bundles to a Weaver registry and fetches them with their dependencies."
        }
    }
}

publishing {
    repositories {
        maven("https://reposilite.slne.dev/releases/") {
            name = "slne-repository-releases"
            credentials {
                username = System.getenv("SLNE_RELEASES_REPO_USERNAME")
                password = System.getenv("SLNE_RELEASES_REPO_PASSWORD")
            }
        }
    }
}

tasks.test {
    useJUnitPlatform()
    // TestKit builds start their own daemons; keep the test JVM from inheriting a registry URL or token.
    environment.remove("WEAVER_URL")
    environment.remove("WEAVER_TOKEN")
}
