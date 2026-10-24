import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND_PAGE");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const protoGroupMember = vi.fn();
const dockerGroupMember = vi.fn();
vi.mock("@/trpc/server", () => ({ api: { browse: { protoGroupMember }, docker: { groupMember: dockerGroupMember } } }));

const { orNotFound, redirectToDockerGroupMember, redirectToGroupMember } = await import("./page-data");

const failing = (code: TRPCError["code"]) => Promise.reject(new TRPCError({ code }));

describe("orNotFound", () => {
  it("passes results through", async () => {
    await expect(orNotFound(Promise.resolve(42), "/browse/x")).resolves.toBe(42);
  });

  it("sends signed-out visitors to the login page and back", async () => {
    await expect(orNotFound(failing("UNAUTHORIZED"), "/browse/x")).rejects.toThrow("REDIRECT /login?next=%2Fbrowse%2Fx");
  });

  it.each(["NOT_FOUND", "FORBIDDEN", "BAD_REQUEST"] as const)("shows the 404 page for %s", async (code) => {
    await expect(orNotFound(failing(code), "/browse/x")).rejects.toThrow("NOT_FOUND_PAGE");
  });

  it("rethrows anything else", async () => {
    await expect(orNotFound(failing("INTERNAL_SERVER_ERROR"), "/browse/x")).rejects.toBeInstanceOf(TRPCError);
  });
});

describe("redirectToGroupMember", () => {
  it("redirects to the member that serves the version", async () => {
    protoGroupMember.mockResolvedValueOnce("proto-demo");
    await expect(redirectToGroupMember("proto-public", "dev.demo", "common", "1.1.0")).rejects.toThrow(
      "REDIRECT /browse/proto-demo/dev.demo/common/1.1.0",
    );
    expect(protoGroupMember).toHaveBeenLastCalledWith({ repository: "proto-public", group: "dev.demo", name: "common", version: "1.1.0" });
  });

  it("returns when no member has it or the repository is not a group", async () => {
    protoGroupMember.mockResolvedValueOnce(null);
    await expect(redirectToGroupMember("proto-public", "dev.demo", "common")).resolves.toBeUndefined();
    protoGroupMember.mockRejectedValueOnce(new TRPCError({ code: "BAD_REQUEST" }));
    await expect(redirectToGroupMember("shared", "dev.demo", "common")).resolves.toBeUndefined();
  });
});

describe("redirectToDockerGroupMember", () => {
  it("redirects to the image or manifest in the member that stores it", async () => {
    dockerGroupMember.mockResolvedValueOnce("images");
    await expect(redirectToDockerGroupMember("imggroup", "web")).rejects.toThrow("REDIRECT /browse/images?image=web");
    dockerGroupMember.mockResolvedValueOnce("images");
    await expect(redirectToDockerGroupMember("imggroup", "web", "sha256:abc")).rejects.toThrow(
      "REDIRECT /browse/images?image=web&digest=sha256%3Aabc",
    );
  });

  it("returns when no member stores it", async () => {
    dockerGroupMember.mockResolvedValueOnce(null);
    await expect(redirectToDockerGroupMember("imggroup", "web")).resolves.toBeUndefined();
  });
});
