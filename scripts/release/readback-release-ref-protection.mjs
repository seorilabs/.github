#!/usr/bin/env node
// 원장 브랜치와 릴리스 태그를 보호하는 organization ruleset을 읽기 전용으로 관측한다.
//
// 이 스크립트는 ruleset을 만들거나 바꾸지 않는다. organization ruleset 변경은
// contracts/provider-auth-matrix.yaml 이 humanOnlyActions로 고정한 사람 전용 행위다.
// 여기서는 desired state와 실제 상태를 대조해 증거 JSON만 남긴다.
//
// 특히 원장 브랜치 ruleset에 update 규칙이 들어가면 원장 갱신 push가 곧 ref update라
// 모든 릴리스가 조용히 죽는다. UI 체크박스 하나로 생기는 사고이므로 금지 규칙 검사를 둔다.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const API_BASE = 'https://api.github.com';
const LEDGER_BRANCH_REF = 'refs/heads/release-version-ledger';
// 넣으면 릴리스가 죽거나 atomic push가 불가능해지는 규칙들.
const FORBIDDEN_LEDGER_RULES = Object.freeze([
  'update',
  'creation',
  'pull_request',
  'required_signatures',
  'required_status_checks',
]);
const FORBIDDEN_TAG_RULES = Object.freeze(['creation']);

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function ruleTypes(ruleset) {
  return (ruleset.rules ?? []).map(({ type }) => type).sort();
}

function refNames(ruleset) {
  return ruleset.conditions?.ref_name?.include ?? [];
}

/**
 * desired state와 관측된 ruleset을 대조한다. 순수 함수라 fixture로 그대로 검증한다.
 *
 * 같은 ref를 덮는 ruleset이 둘 이상 있을 수 있다(실측: 조직에 refs/tags/v* 를 덮는 ruleset이
 * 기존 platform 전용 하나와 새 org 전역 하나로 둘이었다). ref와 target만으로 고르면 엉뚱한
 * ruleset을 desired의 관측값으로 오인하므로 이름을 먼저 맞춘다.
 */
export function evaluateRefProtection({ desired, rulesets, repositories = [], observedAt }) {
  const findings = [];
  const rows = [];

  for (const want of desired) {
    const targetRef = refNames(want)[0];
    const actual =
      rulesets.find((ruleset) => ruleset.name === want.name && ruleset.target === want.target) ?? null;
    const overlapping = rulesets.filter(
      (ruleset) =>
        ruleset.name !== want.name && ruleset.target === want.target && refNames(ruleset).includes(targetRef),
    );
    const forbidden = targetRef === LEDGER_BRANCH_REF ? FORBIDDEN_LEDGER_RULES : FORBIDDEN_TAG_RULES;
    const observedRules = actual === null ? [] : ruleTypes(actual);
    const forbiddenRulesPresent = observedRules.filter((type) => forbidden.includes(type));
    const missingRules = ruleTypes(want).filter((type) => !observedRules.includes(type));
    const bypassActorsEmpty = actual !== null && (actual.bypass_actors ?? []).length === 0;

    rows.push({
      name: want.name,
      id: actual?.id ?? 0,
      target: want.target,
      ref: targetRef,
      present: actual !== null,
      enforcement: actual?.enforcement ?? null,
      desiredEnforcement: 'active',
      exact: actual !== null && missingRules.length === 0 && forbiddenRulesPresent.length === 0 && bypassActorsEmpty,
      bypassActorsEmpty,
      ruleTypes: observedRules,
      missingRules,
      forbiddenRulesPresent,
      overlappingRulesets: overlapping.map((ruleset) => ({
        id: ruleset.id,
        name: ruleset.name,
        enforcement: ruleset.enforcement,
      })),
      snapshotDigest: digest(actual ?? null),
    });

    for (const ruleset of overlapping) {
      findings.push({
        id: 'overlapping-ruleset',
        severity: 'advisory',
        detail: `${want.name}: 같은 ref를 덮는 ruleset이 또 있다 — ${ruleset.name}(${ruleset.id}, ${ruleset.enforcement}). 중복 정리는 사람이 판단한다.`,
      });
    }

    if (actual === null) {
      findings.push({ id: 'ruleset-absent', severity: 'blocking', detail: `${want.name}: ${targetRef} 를 덮는 ruleset이 없다` });
      continue;
    }
    if (forbiddenRulesPresent.length > 0) {
      findings.push({
        id: 'forbidden-rule-present',
        severity: 'blocking',
        detail: `${want.name}: ${forbiddenRulesPresent.join(', ')} 규칙이 있으면 릴리스 push가 막힌다`,
      });
    }
    if (missingRules.length > 0) {
      findings.push({
        id: 'required-rule-missing',
        severity: 'blocking',
        detail: `${want.name}: ${missingRules.join(', ')} 규칙이 없다`,
      });
    }
    if (!bypassActorsEmpty) {
      findings.push({
        id: 'bypass-actor-present',
        severity: 'blocking',
        detail: `${want.name}: bypass_actors 가 비어 있지 않다`,
      });
    }
    if (actual.enforcement !== 'active') {
      findings.push({
        id: 'enforcement-not-active',
        severity: 'advisory',
        detail: `${want.name}: enforcement=${actual.enforcement}. Active 승격은 사람이 한다.`,
      });
    }
  }

  // evaluate 상태 ruleset은 /repos/{full}/rulesets 에 나타나지 않는다(실측). 그 상태에서
  // 커버리지를 false로 단정하면 "적용 안 됨"으로 오인한다. Active 승격 뒤에만 판정한다.
  const allActive = rows.length > 0 && rows.every(({ enforcement }) => enforcement === 'active');
  const observedRepositories = repositories.map((row) =>
    allActive ? row : { ...row, ledgerBranchCovered: null, releaseTagsCovered: null },
  );
  for (const row of observedRepositories) {
    if (allActive && (row.ledgerBranchCovered === false || row.releaseTagsCovered === false)) {
      findings.push({
        id: 'repository-not-covered',
        severity: 'blocking',
        detail: `${row.fullName}: active ruleset이 이 저장소를 덮지 않는다`,
      });
    }
  }

  findings.sort((left, right) => `${left.id}${left.detail}`.localeCompare(`${right.id}${right.detail}`));
  const hasBlocking = findings.some(({ severity }) => severity === 'blocking');

  return {
    schemaVersion: 1,
    ledger: 'release-version-ledger-v1',
    organization: 'seorilabs',
    observedAt,
    rulesets: rows,
    repositories: observedRepositories,
    state: rows.every(({ present }) => present) ? (allActive ? 'ACTIVE' : 'SHADOW') : 'ABSENT',
    findings,
    status: hasBlocking ? 'NEEDS_CHANGE' : allActive ? 'READY' : 'NEEDS_CHANGE',
  };
}

/** GitHub REST 읽기. 이 스크립트는 GET 외의 method를 쓰지 않는다. */
async function get(path, token) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`RELEASE_REF_PROTECTION_READ_FAILED ${path} ${response.status}`);
  }
  return response.json();
}

async function main() {
  const args = process.argv.slice(2);
  const desiredPaths = [];
  const repositories = [];
  let outPath = '';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--desired') {
      desiredPaths.push(args[index + 1]);
      index += 1;
    } else if (args[index] === '--repository') {
      repositories.push(args[index + 1]);
      index += 1;
    } else if (args[index] === '--out') {
      outPath = args[index + 1];
      index += 1;
    } else {
      throw new Error(`RELEASE_REF_PROTECTION_ARGUMENT_INVALID ${args[index]}`);
    }
  }
  if (desiredPaths.length === 0) {
    throw new Error('RELEASE_REF_PROTECTION_DESIRED_REQUIRED');
  }

  const token = process.env.GITHUB_TOKEN ?? '';
  if (token.length === 0 || /[\r\n\0]/u.test(token)) {
    throw new Error('RELEASE_REF_PROTECTION_TOKEN_REQUIRED');
  }

  const desired = desiredPaths.map((path) => JSON.parse(readFileSync(path, 'utf8')));
  const summaries = await get('/orgs/seorilabs/rulesets', token);
  const rulesets = [];
  for (const summary of summaries) {
    rulesets.push(await get(`/orgs/seorilabs/rulesets/${summary.id}`, token));
  }
  const repositoryRows = [];
  for (const fullName of repositories) {
    const applied = await get(`/repos/${fullName}/rulesets?includes_parents=true`, token);
    const names = applied.map(({ name }) => name);
    repositoryRows.push({
      fullName,
      ledgerBranchCovered: names.includes(desired.find((item) => item.target === 'branch')?.name),
      releaseTagsCovered: names.includes(desired.find((item) => item.target === 'tag')?.name),
    });
  }

  const report = evaluateRefProtection({
    desired,
    rulesets,
    repositories: repositoryRows,
    observedAt: new Date().toISOString().replace(/\.\d+Z$/u, 'Z'),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath.length > 0) {
    writeFileSync(outPath, serialized, 'utf8');
  }
  process.stdout.write(serialized);
  return report.status === 'READY' ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
