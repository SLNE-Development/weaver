package dev.weaver.e2e.upstream;

/** A class of the upstream-lib e2e fixture, so the jar has content. */
public final class UpstreamLib {
    private UpstreamLib() {}

    /** The fixture's name and version. */
    public static String id() {
        return "upstream-lib 1.0.0";
    }
}
