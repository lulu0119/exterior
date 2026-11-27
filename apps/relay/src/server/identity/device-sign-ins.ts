import type Database from "better-sqlite3";

type Device = { userId: string; deviceId: string };

const thumbprintExpression = "json_extract(confirmation, '$.jkt')";
const deviceTokenFilter = `userId = @userId and ${thumbprintExpression} = @deviceId`;

export function openDeviceSignIns(database: Database.Database) {
  database.exec(`create index if not exists eap_device_refresh_token on oauthRefreshToken (userId, ${thumbprintExpression})`);
  const hasLiveToken = database.prepare<Device & { now: string }, number>(`
    select exists (
      select 1 from oauthRefreshToken
      where ${deviceTokenFilter} and revoked is null and expiresAt > @now
    )
  `).pluck();
  const deleteTokens = database.prepare<Device>(`delete from oauthRefreshToken where ${deviceTokenFilter}`);

  return {
    isSignedIn(device: Device): boolean {
      return hasLiveToken.get({ ...device, now: new Date().toISOString() }) === 1;
    },
    signOut(device: Device): void {
      deleteTokens.run(device);
    },
  };
}
