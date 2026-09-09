#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { evaluatePreflight } from "./evaluate-preflight.mjs";

export function verifyReceipt(input) {
  const report = input?.report;
  const intent = input?.intent;
  const now = new Date(input?.verificationTime ?? Date.now());
  if (!report || !intent || Number.isNaN(now.getTime())) return { schemaVersion: "1.0.0", valid: false, errorCode: "INVALID_INPUT", reason: "report, intent와 유효한 verificationTime이 필요합니다.", actionDigest: null, targetDigest: null };
  if (report.verdict !== "READY") return { schemaVersion: "1.0.0", valid: false, errorCode: "INVALID_TRANSITION", reason: "READY receipt만 실행 직전 재검증할 수 있습니다.", actionDigest: report.actionDigest ?? null, targetDigest: report.targetDigest ?? null };
  if (Date.parse(report.validUntil) <= now.getTime()) return { schemaVersion: "1.0.0", valid: false, errorCode: "STALE_REVISION", reason: "preflight receipt가 만료됐습니다.", actionDigest: report.actionDigest, targetDigest: report.targetDigest };
  const fresh = evaluatePreflight(intent, { now, validityMinutes: 15 });
  if (fresh.verdict !== "READY" || fresh.actionDigest !== report.actionDigest || fresh.targetDigest !== report.targetDigest || fresh.operationId !== report.operationId) {
    return { schemaVersion: "1.0.0", valid: false, errorCode: "STALE_REVISION", reason: "행동, 대상, 환경, 승인, fingerprint 또는 복구 계획이 바뀌었습니다.", actionDigest: fresh.actionDigest, targetDigest: fresh.targetDigest };
  }
  return { schemaVersion: "1.0.0", valid: true, errorCode: null, reason: "receipt와 현재 mutation intent가 일치합니다. 이 결과는 실행 권한을 새로 부여하지 않습니다.", actionDigest: fresh.actionDigest, targetDigest: fresh.targetDigest };
}

async function readInput(argv) {
  const index = argv.indexOf("--input");
  if (index >= 0) return JSON.parse(await readFile(argv[index + 1], "utf8"));
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
}

async function main() {
  const output = verifyReceipt(await readInput(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = output.valid ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
