#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { resolve, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platformMode = process.argv.includes("--platform");
const platformScriptTests = new Set([
  "scripts/brand-check.test.mjs",
  "scripts/grok-pwa-plugin.test.mjs",
  "scripts/with-app-env.test.mjs",
  "scripts/write-atomic.test.mjs",
]);

async function collect(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...await collect(full));
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) found.push(relative(root, full).split(sep).join("/"));
  }
  return found.sort();
}

const applicationTests = [
  "src/lib/app-data/app-data.test.ts", "src/lib/app-data/readiness-schedule.test.ts", "src/lib/invoice-export.test.ts",
  "src/lib/auth/gate-identity.test.ts", "src/lib/auth/sign-in-gate.test.ts",
  "src/lib/preview-path-prefix.test.ts", "src/lib/tehran-time.test.ts", "src/lib/login-throttle.test.ts",
  "src/lib/stock-release.test.ts", "src/lib/cms-rules.test.ts", "src/lib/seo.test.ts",
  "src/lib/completion-rules.test.ts", "src/lib/customer-profile.test.ts", "src/lib/customer-demographics.test.ts",
  "src/lib/order-display.test.ts", "src/lib/public-profile.test.ts", "src/lib/public-shipping.test.ts",
  "src/lib/commerce-integrity.test.ts", "src/lib/wishlist-rules.test.ts", "src/lib/wishlist-sync.test.ts",
  "src/lib/cart-ui-rules.test.ts", "src/lib/cart-concurrency.test.ts", "src/lib/checkout-cart-safety.test.ts",
  "src/lib/home-carousel.test.ts", "src/components/site/cart-intents.test.ts", "src/components/site/cart-wiring.test.mjs",
  "src/components/site/account-wiring.test.mjs", "src/lib/media-upload-client.test.ts", "src/server/media/disk.test.ts", "src/server/media/sanitize-image.test.ts", "src/server/auth/auth.test.ts",
  "src/server/auth/throttle.integration.test.ts", "src/server/admin/access-control.test.ts",
  "src/server/commerce/pricing.test.ts", "src/server/commerce/integrity.test.ts", "src/server/catalog/rules.test.ts",
  "src/server/offers/rules.test.ts", "src/server/db/migration-0501.test.ts", "src/server/env/runtime.test.ts", "src/server/oil-encyclopedia/client.test.ts",
  "src/server/sms/payping-providers.test.ts",
];
const migrationTests = [
  "src/server/db/migration-0502.test.ts", "src/server/db/migration-release-0019.test.ts",
  "src/server/db/seed-safety.test.ts", "src/server/db/baseline-public.test.ts",
  "src/server/completion/flow.test.ts", "src/server/commerce/checkout-safety.test.ts", "src/server/commerce/batch02.test.ts",
  "src/server/commerce/correction.test.ts", "src/server/auth/admin-bootstrap.test.ts", "src/server/auth/customer-otp.test.ts",
  "src/server/account/addresses.test.ts", "src/server/account/account.test.ts", "src/server/catalog/admin.test.ts",
  "src/server/admin/desk.test.ts", "src/server/cms/content.test.ts", "src/server/storefront/quote-cart-rules.test.ts",
  "src/server/payments/payping-lifecycle.test.ts",
  "scripts/test-remediation-comprehensive.mjs", "scripts/test-remediation-master.mjs",
];
const scriptTests = (await collect(resolve(root, "scripts")))
  .filter((file) => platformMode ? platformScriptTests.has(file) : !platformScriptTests.has(file));
const groups = [
  { name: platformMode ? "platform-harness" : "scripts", args: ["--test", ...scriptTests] },
];
if (!platformMode) {
  groups.push(
    { name: "application", args: ["--experimental-strip-types", "--test", ...applicationTests] },
    { name: "migration-integration", args: ["--experimental-transform-types", "--import", "./scripts/ts-alias-register.mjs", "--test", ...migrationTests] },
  );
}

let failed = false;
for (const group of groups) {
  console.log(`\n[test] ${group.name}`);
  const result = spawnSync(process.execPath, group.args, { cwd: root, stdio: "inherit", windowsHide: true, env: process.env });
  if (result.error) { console.error(result.error); failed = true; continue; }
  if (result.signal || result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
