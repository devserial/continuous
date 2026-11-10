/**
 * What a VS Code deep link may do to the active config profile.
 * A link that names a profile waits for confirmation before it is applied.
 */
export interface ProfileDeepLink {
  /** The link includes profile_id, so applying it changes the active profile. */
  selectsProfile: boolean;
  selectProfileId: string | undefined;
  /** Text safe to show in the confirmation. */
  label: string;
}

export function profileDeepLinkFromQuery(query: string): ProfileDeepLink {
  const params = new URLSearchParams(
    query.startsWith("?") ? query.slice(1) : query,
  );
  if (!params.has("profile_id")) {
    return { selectsProfile: false, selectProfileId: undefined, label: "" };
  }
  const raw = params.get("profile_id");
  if (raw === null || raw === "null" || raw.trim() === "") {
    return {
      selectsProfile: true,
      selectProfileId: undefined,
      label: "the default profile",
    };
  }
  const label = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
  return { selectsProfile: true, selectProfileId: raw, label };
}

export async function handleProfileDeepLink(
  query: string,
  confirm: (label: string) => Promise<boolean>,
  refresh: (selectProfileId: string | undefined) => void,
): Promise<void> {
  const link = profileDeepLinkFromQuery(query);
  if (link.selectsProfile) {
    const allowed = await confirm(link.label);
    if (!allowed) return;
  }
  refresh(link.selectProfileId);
}
