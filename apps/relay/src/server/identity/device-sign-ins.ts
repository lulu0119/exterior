import type Database from "better-sqlite3";
import { expressionBuilder, Kysely, sql, SqliteDialect } from "kysely";

type Device = { userId: string; deviceId: string };

type RefreshTokenDatabase = {
  oauthRefreshToken: {
    userId: string | null;
    confirmation: string | null;
    revoked: string | null;
    expiresAt: string;
  };
};

const refreshToken = expressionBuilder<RefreshTokenDatabase, "oauthRefreshToken">();
const deviceThumbprint = refreshToken.fn<string | null>("json_extract", [refreshToken.ref("confirmation"), sql.lit("$.jkt")]);

function tokenBelongsToDevice({ userId, deviceId }: Device) {
  return refreshToken.and([refreshToken("userId", "=", userId), refreshToken(deviceThumbprint, "=", deviceId)]);
}

export async function openDeviceSignIns(database: Database.Database) {
  const db = new Kysely<RefreshTokenDatabase>({ dialect: new SqliteDialect({ database }) });
  await db.schema.createIndex("eap_device_refresh_token")
    .ifNotExists()
    .on("oauthRefreshToken")
    .column("userId")
    .expression(deviceThumbprint)
    .execute();

  return {
    async isSignedIn(device: Device): Promise<boolean> {
      const liveToken = db.selectFrom("oauthRefreshToken")
        .select("userId")
        .where(tokenBelongsToDevice(device))
        .where("revoked", "is", null)
        .where("expiresAt", ">", new Date().toISOString());
      const { signedIn } = await db.selectNoFrom(({ exists }) => exists(liveToken).as("signedIn")).executeTakeFirstOrThrow();
      return Boolean(signedIn);
    },
    async signOut(device: Device): Promise<void> {
      await db.deleteFrom("oauthRefreshToken").where(tokenBelongsToDevice(device)).execute();
    },
  };
}
