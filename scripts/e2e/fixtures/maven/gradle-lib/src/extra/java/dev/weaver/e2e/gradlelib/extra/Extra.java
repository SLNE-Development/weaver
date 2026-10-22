package dev.weaver.e2e.gradlelib.extra;

/** A class of gradle-lib's `extra` feature, so its jar has content. */
public final class Extra {
    private Extra() {}

    /** The feature's name. */
    public static String id() {
        return "gradle-lib-extra";
    }
}
