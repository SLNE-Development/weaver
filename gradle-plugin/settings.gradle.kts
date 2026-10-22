plugins {
    // Lets Gradle provision the JDK 21 toolchain when none is installed locally.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "weaver-gradle-plugin"
