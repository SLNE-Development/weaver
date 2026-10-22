package dev.weaver.e2e.lib;

/** A class of the maven-lib e2e fixture, so the jar has content. */
public final class MavenLib {
    private MavenLib() {}

    /** The fixture's name and version. */
    public static String id() {
        return "maven-lib 1.0.0";
    }
}
