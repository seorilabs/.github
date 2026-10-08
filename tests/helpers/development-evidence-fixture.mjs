export const SHA = 'a'.repeat(40);
export const NOW = '2026-10-08T06:00:00Z';
export const context = { repository: 'seorilabs/example', sourceSha: SHA, target: 'apps-in-toss', phase: 'before-build', now: NOW,
  featureInventory: { schemaVersion: 1, features: [{ id: 'create', core: true }, { id: 'settings', core: false }] } };
export function validEvidence() {
  return {
    schemaVersion: 1, repository: context.repository, sourceSha: SHA, target: context.target,
    implementer: 'author-agent', productKind: 'ui',
    design: { id: 'design-1', approvedCommit: 'b'.repeat(40), approverKind: 'human', approver: 'owner', approvalEvidence: 'https://example.com/approval', document: 'docs/design/example/design.md' },
    features: [{ id: 'create', core: true }, { id: 'settings', core: false }],
    acceptance: [{ id: 'AC-1', status: 'passed', evidence: ['https://example.com/test'] }],
    tdd: [{ acceptanceId: 'AC-1', mode: 'test-first', redEvidence: 'https://example.com/red', greenEvidence: 'https://example.com/green' }],
    iterations: [1, 2, 3].map(number => ({
      number, sourceSha: SHA, plan: `docs/qa/example/iteration-${number}.md`,
      plannedAt: `2026-10-08T0${number}:00:00Z`, startedAt: `2026-10-08T0${number}:01:00Z`, completedAt: `2026-10-08T0${number}:10:00Z`,
      reviewer: 'review-agent', personas: ['functional-reviewer', 'new-user'],
      functional: { status: 'passed', featureIds: ['create'], evidence: ['https://example.com/functional'] },
      ux: { status: 'passed', featureIds: ['create'], evidence: ['https://example.com/ux'] },
    })),
    additionalIterationApproval: null,
    e2e: {
      phase: 'before-build', sourceSha: SHA, plannedAt: '2026-10-08T05:40:00Z', startedAt: '2026-10-08T05:45:00Z', completedAt: '2026-10-08T05:50:00Z',
      environment: { kind: 'web-browser', configurationFingerprint: 'c'.repeat(64), isolatedData: 'qa-only account' },
      scenarios: [{ id: 'whole-journey', status: 'passed', featureIds: ['create', 'settings'], evidence: ['https://example.com/e2e'] }],
    },
  };
}
