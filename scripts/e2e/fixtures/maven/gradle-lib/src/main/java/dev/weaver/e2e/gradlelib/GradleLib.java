package dev.weaver.e2e.gradlelib;

/** A class of the gradle-lib e2e fixture, so the jar has content. */
public final class GradleLib {
    private GradleLib() {}

    /** The fixture's name. */
    public static String id() {
        return "gradle-lib";
    }
}
