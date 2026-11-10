import { describe, expect, it, vi } from "vitest";
import {
  handleProfileDeepLink,
  profileDeepLinkFromQuery,
} from "./profileDeepLink";

describe("profileDeepLinkFromQuery", () => {
  it("ignores a link that does not name a profile", () => {
    expect(profileDeepLinkFromQuery("")).toEqual({
      selectsProfile: false,
      selectProfileId: undefined,
      label: "",
    });
  });

  it("reads a profile id and the null sentinel", () => {
    expect(profileDeepLinkFromQuery("profile_id=local")).toMatchObject({
      selectsProfile: true,
      selectProfileId: "local",
      label: "local",
    });
    expect(profileDeepLinkFromQuery("profile_id=null").selectProfileId).toBe(
      undefined,
    );
  });
});

describe("handleProfileDeepLink", () => {
  it("refreshes without asking when no profile is named", async () => {
    const confirm = vi.fn(async () => false);
    const refresh = vi.fn();
    await handleProfileDeepLink("", confirm, refresh);
    expect(confirm).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith(undefined);
  });

  it("asks before switching and skips the switch when declined", async () => {
    const confirm = vi.fn(async () => false);
    const refresh = vi.fn();
    await handleProfileDeepLink("profile_id=work", confirm, refresh);
    expect(confirm).toHaveBeenCalledWith("work");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("switches after confirmation", async () => {
    const refresh = vi.fn();
    await handleProfileDeepLink("profile_id=work", async () => true, refresh);
    expect(refresh).toHaveBeenCalledWith("work");
  });
});
