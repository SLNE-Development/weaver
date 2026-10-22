// Resolves gradle-lib through one Weaver repository with stock Gradle (scripts/e2e/maven.sh).
//
//   -PweaverUrl=<repository url> -PweaverUsername=<any> -PweaverPassword=<token>
//   -PsnapshotModule=<group:name:version> (default dev.weaver.e2e:gradle-lib:2.0.0-SNAPSHOT)
//
// runtimeClasspath needs the `extra` feature of gradle-lib 1.0.0 (capability gradle-lib-extra), which
// only its .module file describes; the separate `snapshotClasspath` resolves the snapshot module, and
// `snapshotBuild` prints the build.txt of each jar it resolved.
import java.util.zip.ZipFile

plugins {
    java
}

repositories {
    maven(providers.gradleProperty("weaverUrl").getOrElse("http://localhost:3100/maven/maven-group/")) {
        name = "weaver"
        credentials(PasswordCredentials::class)
        // Weaver runs on plain-http localhost in the e2e stack.
        isAllowInsecureProtocol = true
    }
}

dependencies {
    implementation("dev.weaver.e2e:gradle-lib:1.0.0") {
        capabilities {
            requireCapability("dev.weaver.e2e:gradle-lib-extra")
        }
    }
}

val snapshotDeps = configurations.dependencyScope("snapshotDeps")
val snapshotClasspath = configurations.resolvable("snapshotClasspath") {
    extendsFrom(snapshotDeps.get())
    attributes {
        attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage.JAVA_RUNTIME))
        attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category.LIBRARY))
        attribute(LibraryElements.LIBRARY_ELEMENTS_ATTRIBUTE, objects.named(LibraryElements.JAR))
        attribute(Bundling.BUNDLING_ATTRIBUTE, objects.named(Bundling.EXTERNAL))
    }
}
dependencies {
    "snapshotDeps"(providers.gradleProperty("snapshotModule").getOrElse("dev.weaver.e2e:gradle-lib:2.0.0-SNAPSHOT"))
}

tasks.register("snapshotBuild") {
    val jars: FileCollection = snapshotClasspath.get()
    doLast {
        for (jar in jars.files) {
            val build = ZipFile(jar).use { zip ->
                zip.getEntry("build.txt")?.let { entry -> zip.getInputStream(entry).bufferedReader().readText().trim() }
            }
            println("snapshot ${jar.name} build ${build ?: "none"}")
        }
    }
}
