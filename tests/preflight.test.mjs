import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { canonicalLocator, evaluatePreflight } from "../scripts/evaluate-preflight.mjs";
import { verifyReceipt } from "../scripts/verify-preflight-receipt.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = path.join(root, "tests", "fixtures");
const evaluationTime = "2026-09-09T00:00:00.000Z";

async function fixture(name) {
  return JSON.parse(await readFile(path.join(fixturesRoot, name, "intent.json"), "utf8"));
}

async function directoryDigest(directory) {
  const rows = [];
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else rows.push(path.relative(directory, absolute).replaceAll("\\", "/") + ":" + createHash("sha256").update(await readFile(absolute)).digest("hex"));
    }
  }
  await walk(directory);
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

test("정상·경계·실패 fixture가 실제 판정과 일치한다", async () => {
  const behavior = JSON.parse(await readFile(path.join(root, "tests", "behavior-cases.json"), "utf8"));
  assert.deepEqual(new Set(behavior.cases.map((item) => item.class)), new Set(["normal", "boundary", "expected-failure"]));
  for (const item of behavior.cases) {
    const report = evaluatePreflight(await fixture(item.fixture), { now: evaluationTime });
    assert.equal(report.verdict, item.expectedVerdict, item.id);
  }
});

test("READY 보고서는 계약을 통과하고 실행 권한을 부여하지 않는다", async () => {
  const intent = await fixture("local-delete");
  const report = evaluatePreflight(intent, { now: evaluationTime });
  const inputSchema = JSON.parse(await readFile(path.join(root, "contracts", "mutation-intent.v1.schema.json"), "utf8"));
  const schema = JSON.parse(await readFile(path.join(root, "contracts", "mutation-preflight-report.v1.schema.json"), "utf8"));
  const ajv = new Ajv2020({ strict: true, formats: { "date-time": true } });
  assert.equal(ajv.compile(inputSchema)(intent), true);
  const validate = ajv.compile(schema);
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  assert.equal(report.verdict, "READY");
  assert.equal("authorized" in report, false);
  assert.match(report.checks.find((item) => item.checkId === "authorization-match").message, /허용 범위/);
});

test("receipt는 대상 fingerprint, action과 만료 시각 변경을 거부한다", async () => {
  const intent = await fixture("local-delete");
  const report = evaluatePreflight(intent, { now: evaluationTime });
  assert.equal(verifyReceipt({ report, intent, verificationTime: "2026-09-09T00:01:00.000Z" }).valid, true);
  const changed = structuredClone(intent);
  changed.targets[0].expectedFingerprint = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  changed.currentStateEvidenceRefs[0].fingerprint = changed.targets[0].expectedFingerprint;
  const stale = verifyReceipt({ report, intent: changed, verificationTime: "2026-09-09T00:01:00.000Z" });
  assert.equal(stale.valid, false);
  assert.equal(stale.errorCode, "STALE_REVISION");
  const expired = verifyReceipt({ report, intent, verificationTime: "2026-09-09T00:16:00.000Z" });
  assert.equal(expired.valid, false);
  assert.equal(expired.errorCode, "STALE_REVISION");
});

test("Windows drive·UNC root와 변수·glob target은 안전하지 않다", async () => {
  assert.equal(canonicalLocator("D:\\Repo\\file.txt"), "d:/Repo/file.txt");
  for (const locator of ["C:\\", "\\\\server\\share", "%USERPROFILE%\\x", "D:\\repo\\*", "~"]) {
    const intent = await fixture("local-delete");
    intent.targets[0].locator = locator;
    intent.scopeRef.includedTargets = [locator];
    intent.authorizationRef.allowedTargets = [locator];
    intent.approvalEvidenceRefs[0].targetLocators = [locator];
    intent.currentStateEvidenceRefs[0].targetLocator = locator;
    assert.equal(evaluatePreflight(intent, { now: evaluationTime }).verdict, "BLOCKED", locator);
  }
});

test("JSON CLI는 MCP와 suite import 없이 직접 실행되고 아무 파일도 바꾸지 않는다", async () => {
  const inputPath = path.join(fixturesRoot, "local-delete", "intent.json");
  const before = await directoryDigest(fixturesRoot);
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "evaluate-preflight.mjs"), "--input", inputPath], {
    encoding: "utf8",
    env: { PATH: process.env.PATH }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verdict, "READY");
  assert.equal(await directoryDigest(fixturesRoot), before);
  const source = [
    await readFile(path.join(root, "scripts", "evaluate-preflight.mjs"), "utf8"),
    await readFile(path.join(root, "scripts", "verify-preflight-receipt.mjs"), "utf8")
  ].join("\n");
  assert.doesNotMatch(source, /agent-governance-suite|mcp-server|skills\\registry/);
  assert.doesNotMatch(source, /node:child_process|\bwriteFile\b|\bunlink\b|\brename\b|\brmSync\b|\bfetch\s*\(/);
});

test("vendored TaskEnvelope snapshot checksum이 lock과 일치한다", async () => {
  const lock = JSON.parse(await readFile(path.join(root, "contracts", "upstream", "lock.json"), "utf8"));
  const item = lock.upstreams[0];
  const snapshot = await readFile(path.join(root, item.snapshotPath));
  assert.equal(createHash("sha256").update(snapshot).digest("hex"), item.sha256);
  const parsed = JSON.parse(snapshot);
  assert.equal(parsed.$id, item.schemaId);
  assert.equal(item.supplierVersion, "0.1.0");
});

test("integration descriptor는 precondition gate이고 독립 감사로 가장하지 않는다", async () => {
  const descriptor = JSON.parse(await readFile(path.join(root, "integration", "skill-descriptor.json"), "utf8")).providers[0];
  assert.deepEqual(descriptor.gate, {
    kind: "precondition",
    policy: "conditional",
    validator: "contracts/mutation-preflight-report.v1.schema.json"
  });
  assert.ok(!descriptor.capabilities.includes("independent-audit"));
  assert.equal(descriptor.phaseOrder, 45);
});
