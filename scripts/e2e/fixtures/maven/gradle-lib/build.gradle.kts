// dev.weaver.e2e:gradle-lib, published with stock maven-publish and signing (scripts/e2e/maven.sh).
//
//   -PweaverUrl=<repository url> -PweaverUsername=<any> -PweaverPassword=<token>
//   -PlibVersion=<version> (default 1.0.0)  -Pbuild=<n> (written to build.txt in the jar)
//   -PsigningKey=<ascii-armored secret key> [-PsigningPassword=<passphrase>] signs the publication
//
// The feature variant `extra` depends on maven-lib, which only Gradle module metadata (.module)
// describes, so a consumer resolves it only when Weaver serves the .module file.
plugins {
    `java-library`
    `maven-publish`
    signing
}

group = "dev.weaver.e2e"
version = providers.gradleProperty("libVersion").getOrElse("1.0.0")

val extra: SourceSet = sourceSets.create("extra")

java {
    registerFeature("extra") {
        usingSourceSet(extra)
    }
}

tasks.withType<JavaCompile>().configureEach {
    options.release = 17
}

val weaverUrl = providers.gradleProperty("weaverUrl").getOrElse("http://localhost:3100/maven/maven-hosted/")

// The same repository resolves maven-lib for compiling the extra feature and takes the publication.
repositories {
    maven(weaverUrl) {
        name = "weaver"
        credentials(PasswordCredentials::class)
        // Weaver runs on plain-http localhost in the e2e stack.
        isAllowInsecureProtocol = true
    }
}

dependencies {
    "extraImplementation"("dev.weaver.e2e:maven-lib:1.0.0")
}

val buildNumber = providers.gradleProperty("build").getOrElse("0")
val buildInfo = tasks.register("buildInfo") {
    val out = layout.buildDirectory.file("build-info/build.txt")
    inputs.property("build", buildNumber)
    outputs.file(out)
    doLast { out.get().asFile.writeText("$buildNumber\n") }
}
tasks.jar {
    from(buildInfo)
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            // The extra feature exists only in the .module file, on purpose.
            suppressPomMetadataWarningsFor("extraApiElements")
            suppressPomMetadataWarningsFor("extraRuntimeElements")
        }
    }
    repositories {
        maven(weaverUrl) {
            name = "weaver"
            credentials(PasswordCredentials::class)
            // Weaver runs on plain-http localhost in the e2e stack.
            isAllowInsecureProtocol = true
        }
    }
}

val signingKey = providers.gradleProperty("signingKey")
if (signingKey.isPresent) {
    signing {
        useInMemoryPgpKeys(signingKey.get(), providers.gradleProperty("signingPassword").getOrElse(""))
        sign(publishing.publications["maven"])
    }
}
