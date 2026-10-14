// 등급제(v2) 근거 검증의 공통 입력. 가상 데이터이며 실제 제품 검수 결과가 아니다.
export const SHA = 'a'.repeat(40);
export const APPROVED = 'b'.repeat(40);
export const NOW = '2026-10-14T06:00:00Z';
export const DESIGN = 'D-1';

export const inventory = () => ({
  schemaVersion: 1,
  features: [
    { id: 'create', core: true, paths: ['src/create/**'] },
    { id: 'settings', core: false, paths: ['src/settings/**'] },
    { id: 'store', core: true },
    { id: 'purchase', core: true, foundation: true, paths: ['src/purchase/**'] },
    { id: 'ads', core: false, foundation: true, paths: ['src/ads/**'] },
  ],
});

export const plan = (changes = {}) => ({
  schemaVersion: 1, level: 'L1', baseline: 'v1.0.0', changedFeatures: ['settings'], environments: ['dev'],
  redesign: false, foundationRerun: false, floorOverrides: [],
  release: { markets: ['google-play'], until: 'public' },
  ...changes,
});

export const context = (changes = {}) => ({
  repository: 'seorilabs/example', sourceSha: SHA, target: 'google-play', phase: 'before-build', now: NOW,
  featureInventory: inventory(),
  plans: { [DESIGN]: { approved: true, plan: plan() } },
  changes: { 'v1.0.0': ['src/settings/screen.ts'] },
  ...changes,
});

export const run = (id, kind, featureIds, changes = {}) => ({
  id, kind, sourceSha: SHA, executor: 'author-agent',
  plannedAt: '2026-10-14T05:00:00Z', startedAt: '2026-10-14T05:01:00Z', completedAt: '2026-10-14T05:10:00Z',
  isolatedData: 'QA 전용 저장 슬롯',
  ...(['android-device', 'ios-device'].includes(kind)
    ? { target: kind === 'ios-device' ? 'app-store' : 'google-play', device: kind === 'ios-device' ? 'iPhone 15 / iOS 26' : 'Pixel 8 / Android 16', build: 'internal 21' }
    : {}),
  scenarios: [{ id: `${id}-S1`, status: 'passed', featureIds, evidence: [`https://example.com/${id}`] }],
  ...changes,
});

export const evidence = (changes = {}) => ({
  schemaVersion: 2, repository: 'seorilabs/example', sourceSha: SHA, target: 'google-play',
  productKind: 'ui', implementer: 'author-agent',
  designs: [{
    id: DESIGN, document: 'docs/design/2026-10-14-example/design.md', testPlan: 'docs/design/2026-10-14-example/test-plan.json',
    approvedCommit: APPROVED, approverKind: 'human', approver: 'owner', approvalEvidence: 'https://example.com/approval',
  }],
  acceptance: [{ id: 'AC-1', status: 'passed', evidence: ['https://example.com/test'] }],
  tdd: [{ acceptanceId: 'AC-1', mode: 'test-first', redEvidence: 'https://example.com/red', greenEvidence: 'https://example.com/green' }],
  reviewRounds: [],
  additionalIterationApproval: null,
  runs: [run('dev-1', 'godot-editor', ['settings'])],
  ...changes,
});

export const ALL_FEATURES = ['create', 'settings', 'store', 'purchase', 'ads'];

export const rounds = (featureIds = ['create', 'store', 'purchase']) => [1, 2, 3].map(number => ({
  number, sourceSha: SHA, plan: `docs/qa/example/iteration-${number}.md`,
  plannedAt: `2026-10-14T0${number}:00:00Z`, startedAt: `2026-10-14T0${number}:01:00Z`, completedAt: `2026-10-14T0${number}:10:00Z`,
  reviewer: 'review-agent', personas: ['functional-reviewer', 'new-user'],
  functional: { status: 'passed', featureIds, evidence: ['https://example.com/functional'] },
  ux: { status: 'passed', featureIds, evidence: ['https://example.com/ux'] },
}));
