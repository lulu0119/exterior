import type { ExteriorAuth } from "./auth.js";

type StoredRefreshToken = {
  id: string;
  userId?: string | null;
  expiresAt: Date | string;
  revoked?: Date | string | null;
  confirmation?: { jkt?: string } | null;
};

/**
 * Whether the account still has a sign-in for the device: a live refresh token bound to its key. A device's access
 * token outlives removal and `logout` until it expires, so the device socket is opened only while this holds.
 */
export async function deviceSignedIn(exterior: ExteriorAuth, input: { userId: string; deviceId: string }): Promise<boolean> {
  return (await deviceRefreshTokens(exterior, input)).some((row) => !row.revoked && new Date(row.expiresAt).getTime() > Date.now());
}

/**
 * Signs the device out of the account: deletes every refresh token bound to its key. Deleted rather than marked
 * revoked: the provider answers a replayed revoked token by revoking the whole family of the client and account,
 * which would sign out every other device that uses the same device software.
 */
export async function signOutDevice(exterior: ExteriorAuth, input: { userId: string; deviceId: string }): Promise<void> {
  const context = await exterior.auth.$context;
  for (const row of await deviceRefreshTokens(exterior, input)) {
    await context.adapter.delete({ model: "oauthRefreshToken", where: [{ field: "id", value: row.id }] });
  }
}

async function deviceRefreshTokens(exterior: ExteriorAuth, input: { userId: string; deviceId: string }): Promise<StoredRefreshToken[]> {
  const { adapter } = await exterior.auth.$context;
  const account = { field: "userId", value: input.userId };
  const pageSize = 100;
  const tokens: StoredRefreshToken[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = await adapter.findMany<StoredRefreshToken>({
      model: "oauthRefreshToken",
      select: ["id", "userId", "confirmation", "expiresAt", "revoked"],
      where: afterId === undefined ? [account] : [account, { field: "id", operator: "gt", value: afterId }],
      sortBy: { field: "id", direction: "asc" },
      limit: pageSize,
    });
    for (const row of page) {
      if (row.userId === input.userId && row.confirmation?.jkt === input.deviceId) tokens.push(row);
    }
    const last = page.at(-1);
    if (!last || page.length < pageSize) return tokens;
    afterId = last.id;
  }
}
