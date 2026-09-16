// 원장 브랜치와 릴리스 태그 보호 ruleset의 desired state와 readback 계약이다.
//
// 가장 위험한 실수는 원장 브랜치에 update 규칙을 켜는 것이다. 원장 갱신 push가 곧 ref update라
// 그 순간 조직의 모든 릴리스가 조용히 죽는다. UI 체크박스 하나 차이이므로 금지 규칙 검사를 둔다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { evaluateRefProtection } from '../scripts/release/readback-release-ref-protection.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const READBACK_CLI = resolve(REPOSITORY_ROOT, 'scripts/release/readback-release-ref-protection.mjs');
const LEDGER_BRANCH_DESIRED = JSON.parse(
  readFileSync(resolve(REPOSITORY_ROOT, 'contracts/release-ref-protection.ledger-branch.json'), 'utf8'),
);
const RELEASE_TAGS_DESIRED = JSON.parse(
  readFileSync(resolve(REPOSITORY_ROOT, 'contracts/release-ref-protection.release-tags.json'), 'utf8'),
);
const DESIRED = [LEDGER_BRANCH_DESIRED, RELEASE_TAGS_DESIRED];
const LEDGER_CONTRACT = parse(
  readFileSync(resolve(REPOSITORY_ROOT, 'contracts/release-version-ledger.yaml'), 'utf8'),
);

function observed(overrides = {}) {
  return DESIRED.map((desired) => ({
    ...structuredClone(desired),
    id: desired.target === 'branch' ? 1 : 2,
    enforcement: 'active',
    ...(overrides[desired.target] ?? {}),
  }));
}

test('desired state는 릴리스를 죽이는 규칙을 담지 않는다', () => {
  // update: 원장 갱신 push가 곧 ref update다. 켜는 순간 모든 릴리스가 실패한다.
  // required_signatures: atomic push로 만든 커밋은 서명되지 않는다. REST 커밋 생성은 서명할 수
  //   있지만 ref 두 개의 atomic 갱신을 제공하지 않아 부분 성공 금지가 깨진다.
  // creation: 신규 저장소의 원장 브랜치 생성과 신규 태그 생성을 막는다.
  const ledgerRules = LEDGER_BRANCH_DESIRED.rules.map(({ type }) => type);
  assert.deepEqual(ledgerRules.toSorted(), ['deletion', 'non_fast_forward', 'required_linear_history']);
  for (const forbidden of LEDGER_CONTRACT.refProtection.ledgerBranch.forbiddenRules) {
    assert.ok(!ledgerRules.includes(forbidden), forbidden);
  }

  const tagRules = RELEASE_TAGS_DESIRED.rules.map(({ type }) => type);
  assert.deepEqual(tagRules.toSorted(), ['deletion', 'non_fast_forward', 'update']);
  for (const forbidden of LEDGER_CONTRACT.refProtection.releaseTags.forbiddenRules) {
    assert.ok(!tagRules.includes(forbidden), forbidden);
  }

  for (const desired of DESIRED) {
    // 조직 관리자조차 우회할 수 없어야 한다. 우회가 필요하면 ruleset 자체를 고쳐야 하고,
    // 그 변경은 감사 로그에 남는다.
    assert.deepEqual(desired.bypass_actors, []);
    // 새 앱이 추가될 때마다 사람이 ID를 더하는 구조는 영구 드리프트를 만든다.
    assert.deepEqual(desired.conditions.repository_name.include, ['~ALL']);
    // 처음에는 evaluate로 올리고 Active 승격은 사람이 한다.
    assert.equal(desired.enforcement, 'evaluate');
  }
  assert.deepEqual(
    LEDGER_CONTRACT.refProtection.rolloutOrder,
    ['initialize-ledger', 'create-ruleset-evaluate', 'shadow-readback', 'promote-active'],
  );
});

test('desired와 같은 ruleset이 active면 READY로 보고한다', () => {
  const report = evaluateRefProtection({
    desired: DESIRED,
    rulesets: observed(),
    observedAt: '2026-09-16T00:00:00Z',
  });
  assert.equal(report.state, 'ACTIVE');
  assert.equal(report.status, 'READY');
  assert.deepEqual(report.findings, []);
  assert.ok(report.rulesets.every(({ exact, bypassActorsEmpty }) => exact && bypassActorsEmpty));
});

test('evaluate 상태는 관측으로 남기되 완료로 보고하지 않는다', () => {
  const report = evaluateRefProtection({
    desired: DESIRED,
    rulesets: observed({ branch: { enforcement: 'evaluate' }, tag: { enforcement: 'evaluate' } }),
    observedAt: '2026-09-16T00:00:00Z',
  });
  assert.equal(report.state, 'SHADOW');
  assert.equal(report.status, 'NEEDS_CHANGE');
  assert.deepEqual(
    report.findings.map(({ id, severity }) => [id, severity]),
    [
      ['enforcement-not-active', 'advisory'],
      ['enforcement-not-active', 'advisory'],
    ],
  );
});

test('원장 브랜치에 update 규칙이 켜지면 blocking으로 잡는다', () => {
  const report = evaluateRefProtection({
    desired: DESIRED,
    rulesets: observed({
      branch: { rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'required_linear_history' }, { type: 'update' }] },
    }),
    observedAt: '2026-09-16T00:00:00Z',
  });
  assert.equal(report.status, 'NEEDS_CHANGE');
  const finding = report.findings.find(({ id }) => id === 'forbidden-rule-present');
  assert.ok(finding, JSON.stringify(report.findings));
  assert.match(finding.detail, /update/u);
  assert.equal(report.rulesets[0].forbiddenRulesPresent[0], 'update');
});

test('bypass actor가 있거나 ruleset이 없으면 blocking이다', () => {
  const withBypass = evaluateRefProtection({
    desired: DESIRED,
    rulesets: observed({ tag: { bypass_actors: [{ actor_id: 1, actor_type: 'OrganizationAdmin' }] } }),
    observedAt: '2026-09-16T00:00:00Z',
  });
  assert.ok(withBypass.findings.some(({ id }) => id === 'bypass-actor-present'));

  const absent = evaluateRefProtection({
    desired: DESIRED,
    rulesets: [],
    observedAt: '2026-09-16T00:00:00Z',
  });
  assert.equal(absent.state, 'ABSENT');
  assert.equal(absent.status, 'NEEDS_CHANGE');
  assert.equal(absent.findings.filter(({ id }) => id === 'ruleset-absent').length, 2);
});

test('readback은 읽기만 한다. ruleset을 만들거나 바꾸지 않는다', () => {
  const source = readFileSync(READBACK_CLI, 'utf8');
  assert.match(source, /method: 'GET'/u);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.doesNotMatch(source, new RegExp(`method: '${method}'`, 'u'), method);
  }
  assert.doesNotMatch(source, /--method/u);
  assert.equal(LEDGER_CONTRACT.refProtection.approval, 'human-only');
});

test('같은 ref를 덮는 다른 ruleset을 desired의 관측값으로 오인하지 않는다', () => {
  // 실측: 조직에 refs/tags/v* 를 덮는 ruleset이 둘이었다. 기존 platform 전용(active)과
  // 새 org 전역(evaluate). ref와 target만으로 고르면 옛 것을 새 것으로 읽는다.
  const legacyTagRuleset = {
    id: 21819735,
    name: 'Immutable Platform release tags',
    target: 'tag',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'update' }],
  };

  const report = evaluateRefProtection({
    desired: DESIRED,
    rulesets: [legacyTagRuleset, ...observed({ tag: { enforcement: 'evaluate' }, branch: { enforcement: 'evaluate' } })],
    observedAt: '2026-09-16T00:00:00Z',
  });

  const tagRow = report.rulesets.find(({ target }) => target === 'tag');
  assert.equal(tagRow.name, 'Immutable release tags');
  assert.equal(tagRow.id, 2, '옛 ruleset의 id를 읽으면 안 된다');
  assert.deepEqual(tagRow.missingRules, [], '옛 ruleset의 규칙으로 판정하면 non_fast_forward가 빠진 것처럼 보인다');
  assert.deepEqual(tagRow.overlappingRulesets, [
    { id: 21819735, name: 'Immutable Platform release tags', enforcement: 'active' },
  ]);
  assert.ok(report.findings.some(({ id }) => id === 'overlapping-ruleset'));
  // 중복은 사람이 판단할 일이지 배포를 막을 일이 아니다.
  assert.equal(report.findings.find(({ id }) => id === 'overlapping-ruleset').severity, 'advisory');
});

test('evaluate 상태에서는 저장소 커버리지를 단정하지 않는다', () => {
  // evaluate ruleset은 /repos/{full}/rulesets 에 나타나지 않는다(실측).
  // 그 상태의 false는 "적용 안 됨"이 아니라 "아직 알 수 없음"이다.
  const shadow = evaluateRefProtection({
    desired: DESIRED,
    rulesets: observed({ branch: { enforcement: 'evaluate' }, tag: { enforcement: 'evaluate' } }),
    repositories: [{ fullName: 'seorilabs/lord-ledger', ledgerBranchCovered: false, releaseTagsCovered: false }],
    observedAt: '2026-09-16T00:00:00Z',
  });
  assert.deepEqual(shadow.repositories, [
    { fullName: 'seorilabs/lord-ledger', ledgerBranchCovered: null, releaseTagsCovered: null },
  ]);
  assert.ok(!shadow.findings.some(({ id }) => id === 'repository-not-covered'));

  // Active 뒤에도 덮이지 않으면 그때는 blocking이다.
  const active = evaluateRefProtection({
    desired: DESIRED,
    rulesets: observed(),
    repositories: [{ fullName: 'seorilabs/lord-ledger', ledgerBranchCovered: false, releaseTagsCovered: true }],
    observedAt: '2026-09-16T00:00:00Z',
  });
  assert.equal(active.findings.find(({ id }) => id === 'repository-not-covered').severity, 'blocking');
  assert.equal(active.status, 'NEEDS_CHANGE');
});
