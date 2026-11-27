import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "../../../scripts/migration-plan.mjs";

const migrationsDir = new URL("../../../migrations/", import.meta.url);
const lastBaselineMigration = "0016_batch_09_verification_recovery.sql";
const releaseMigrations = [
  "0017_content_revisions.sql",
  "0018_order_fulfillment_work.sql",
  "0019_shipping_address_snapshots.sql",
];

test("0017–0019 preserve an existing order and shipment on upgrade from 0016", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const baseline = pendingMigrations(readdirSync(migrationsDir), [])
    .map(({ name }) => name)
    .filter((name) => name <= lastBaselineMigration);
  assert.equal(baseline.at(-1), lastBaselineMigration);

  for (const name of baseline) {
    await db.exec(readFileSync(new URL(name, migrationsDir), "utf8"));
  }
  await db.exec(`
    INSERT INTO orders (
      id, public_code, status, full_name, mobile, province, city, address_line, subtotal_irr, total_irr
    ) VALUES (
      'legacy-order', 'SH-QA-0016', 'shipped', 'Fixture Customer', '09120000000',
      'Tehran', 'Tehran', 'Old fixture address', 100000, 110000
    );
    INSERT INTO shipping_logs (id, order_id, status, carrier, tracking_code)
    VALUES ('legacy-shipment', 'legacy-order', 'shipped', 'manual', 'QA-TRACK');
  `);
  for (const name of releaseMigrations) {
    await db.exec(readFileSync(new URL(name, migrationsDir), "utf8"));
  }

  const shipment = await db.query(`
    SELECT o.public_code, s.carrier, s.tracking_code, s.sender_snapshot, s.recipient_snapshot
    FROM shipping_logs s JOIN orders o ON o.id = s.order_id
    WHERE s.id = 'legacy-shipment'
  `);
  assert.deepEqual(shipment.rows, [{
    public_code: "SH-QA-0016",
    carrier: "manual",
    tracking_code: "QA-TRACK",
    sender_snapshot: null,
    recipient_snapshot: null,
  }]);

  await db.exec(`
    INSERT INTO content_revisions (id, entity_type, entity_id, version, snapshot)
    VALUES ('revision-1', 'page', 'page-1', 1, '{"title":"Fixture"}');
    INSERT INTO order_fulfillment_work (id, order_id)
    VALUES ('packing-1', 'legacy-order');
    UPDATE shipping_logs
    SET sender_snapshot = '{"city":"Tehran"}', recipient_snapshot = '{"city":"Rasht"}'
    WHERE id = 'legacy-shipment';
  `);
  await assert.rejects(db.exec(`
    INSERT INTO content_revisions (id, entity_type, entity_id, version, snapshot)
    VALUES ('duplicate-revision', 'page', 'page-1', 1, '{}');
  `), { code: "23505" });
  await assert.rejects(db.exec(`
    INSERT INTO order_fulfillment_work (id, order_id)
    VALUES ('duplicate-packing', 'legacy-order');
  `), { code: "23505" });

  for (const name of releaseMigrations) {
    await db.exec(readFileSync(new URL(name, migrationsDir), "utf8"));
  }
  const saved = await db.query(`
    SELECT s.sender_snapshot, s.recipient_snapshot, f.picked_items, f.package_count,
           (SELECT snapshot FROM content_revisions WHERE id = 'revision-1') AS revision
    FROM shipping_logs s JOIN order_fulfillment_work f ON f.order_id = s.order_id
    WHERE s.id = 'legacy-shipment'
  `);
  assert.deepEqual(saved.rows, [{
    sender_snapshot: { city: "Tehran" },
    recipient_snapshot: { city: "Rasht" },
    picked_items: [],
    package_count: 1,
    revision: { title: "Fixture" },
  }]);
});
