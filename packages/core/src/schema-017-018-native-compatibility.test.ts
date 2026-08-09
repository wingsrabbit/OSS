// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSchema018NativeSafe,
  SCHEMA_018,
} from "./schema-017-018-native-compatibility.js";

test("schema 018 native preflight accepts the reviewed ticket shape", async () => {
  const report = await assertSchema018NativeSafe({
    query: async () => ({
      rows: [
        {
          installed_schema_version: SCHEMA_018,
          history_exact: true,
          tickets_table: "support_tickets",
          messages_table: "support_ticket_messages",
          client_index: "support_tickets_client_updated_idx",
          message_index: "support_ticket_messages_ticket_created_idx",
        },
      ],
    }),
  });
  assert.equal(report.mode, "native");
  assert.equal(report.installedSchemaVersion, SCHEMA_018);
});

test("schema 018 native preflight rejects the older schema", async () => {
  await assert.rejects(
    assertSchema018NativeSafe({
      query: async () => ({
        rows: [
          {
            installed_schema_version: "017_stage_b_manual_receipt_outflow_reports",
            history_exact: false,
            tickets_table: null,
            messages_table: null,
            client_index: null,
            message_index: null,
          },
        ],
      }),
    }),
    /incompatible with application schema 018_stage_c_support_tickets/,
  );
});
