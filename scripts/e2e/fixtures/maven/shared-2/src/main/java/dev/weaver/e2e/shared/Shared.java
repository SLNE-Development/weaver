package dev.weaver.e2e.shared;

/** A class of the shared e2e fixture, so the jar has content. */
public final class Shared {
    private Shared() {}

    /** The fixture's name and version. */
    public static String id() {
        return "shared 2.0.0";
    }
}
