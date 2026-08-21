// SPDX-License-Identifier: AGPL-3.0-or-later

import { createOpaqueToken, digestToken } from "./auth.js";
import { transaction, type DatabasePool } from "./database.js";

export async function issueInitialStaffBootstrapToken(
  pool: DatabasePool,
): Promise<Readonly<{ token: string; expiresAt: Date }>> {
  const token = createOpaqueToken();
  const expiresAt = await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      "opensales:staff-bootstrap",
    ]);
    const existingStaff = await client.query("SELECT 1 FROM staff_members LIMIT 1");
    if (existingStaff.rowCount !== 0) {
      throw new Error("Staff bootstrap is already complete");
    }
    await client.query(
      "UPDATE staff_bootstrap_tokens SET used_at = now() WHERE used_at IS NULL",
    );
    const inserted = await client.query<{ expires_at: Date }>(
      `INSERT INTO staff_bootstrap_tokens(token_digest, expires_at)
       VALUES ($1, pg_catalog.clock_timestamp() + interval '15 minutes')
       RETURNING expires_at`,
      [digestToken(token)],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("Unable to create Staff bootstrap token");
    return row.expires_at;
  });
  return { token, expiresAt };
}
