#!/usr/bin/env node
// caller 저장소를 release-version-authority-v1로 옮기기 위한 기계 판독 inventory를 만든다.
// 저장소를 수정하지 않고 읽기만 한다. 결과는 contracts/release-version-authority-migration.schema.json을
// 만족하는 JSON이며, fan-out 단계가 이 결과만 보고 저장소별 변경을 만든다.
//
// I/O와 판정을 분리한다. snapshot을 만드는 쪽만 파일이나 GitHub를 읽고, 판정은 순수 함수다.
// 기본 소스가 GitHub인 이유: 로컬 복제본이 stale이면 pin 판별이 조용히 틀린다. 실측 예로
// seorilabs/lord-ledger의 로컬 clone은 9afa357f를, 원격 main은 565fba53을 가리키고 있었다.
//
// 사용법:
//   node collect-caller-migration-inventory.mjs seorilabs/<repo> [--expected-central-sha <40hex>]
//   node collect-caller-migration-inventory.mjs <저장소 경로> --source filesystem
//   node collect-caller-migration-inventory.mjs --fleet --repositories-from <policy.yaml>
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReleaseAuthorityError } from './tag-version-authority.mjs';

const MIGRATION_ID = 'release-version-authority-migration-v1';
const LEDGER_BRANCH = 'release-version-ledger';
const READ_FILES = Object.freeze([
  'scripts/resolve-release-version.mjs',
  'play-store/google-play.config.json',
  'app-store/app-store.config.json',
]);
const AUTHORITY_ID = 'release-version-authority-v1';
const CALLER_USES =
  /^seorilabs\/\.github\/(\.github\/workflows\/[a-z0-9-]+\.yml)@([0-9a-f]{40}|[^\s'"]+)$/u;
const REMOVED_INPUTS = Object.freeze(['version_name', 'version_code', 'version_script']);

/** called workflow 경로 하나가 어떤 caller kind인지 고정한다. */
export const CALLER_KIND_BY_WORKFLOW = Object.freeze({
  '.github/workflows/rn-deploy-google-play.yml': 'rn-deploy-google-play',
  '.github/workflows/godot-deploy-google-play.yml': 'godot-deploy-google-play',
  '.github/workflows/rn-deploy-ait.yml': 'rn-deploy-ait',
  '.github/workflows/godot-deploy-ait.yml': 'godot-deploy-ait',
  '.github/workflows/release-tag.yml': 'release-tag',
  '.github/workflows/promote-google-play.yml': 'promote-google-play',
  '.github/workflows/init-release-version-ledger.yml': 'init-release-version-ledger',
  '.github/workflows/record-ios-build-observation.yml': 'record-ios-build-observation',
});

/** 고정 enum. 자유 서술 제외는 허용하지 않는다 — 미이관 목록이 기계 판독이어야 한다. */
export const EXCLUSION_REASONS = Object.freeze([
  'no-central-caller',
  'no-central-release-tag-caller',
  'archived-repository',
  'no-market-release-target',
  'blocked-awaiting-provider-readback',
  'human-hold',
]);

/**
 * 더 이상 존재하지 않는 caller 입력. 권한 있는 job의 러너는 caller가 고를 수 없게 고정했으므로
 * runs_on을 계속 넘기면 workflow_call이 unknown input으로 실패한다.
 */
const OBSOLETE_INPUTS_BY_KIND = Object.freeze({
  'release-tag': Object.freeze(['runs_on']),
  'godot-deploy-google-play': Object.freeze(['runs_on']),
});

function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * caller workflow 하나에서 org 정본 호출을 찾는다. YAML 파서 의존을 피하려고 uses/with 줄만
 * 읽는다. caller는 생성기가 만든 thin caller라 구조가 고정돼 있다.
 */
export function collectCallerUses(text) {
  const lines = String(text ?? '').split('\n');
  const found = [];
  let current = null;
  let usesIndent = 0;
  let jobKey = 'unknown';
  for (const line of lines) {
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (job !== null) {
      jobKey = job[1];
      current = null;
      continue;
    }
    const uses = /^(\s*)uses:\s*['"]?([^'"\s#]+)['"]?/u.exec(line);
    if (uses !== null) {
      const match = CALLER_USES.exec(uses[2]);
      usesIndent = uses[1].length;
      current =
        match === null
          ? null
          : {
              jobKey,
              calledWorkflow: match[1],
              calledWorkflowSha: /^[0-9a-f]{40}$/u.test(match[2]) ? match[2] : null,
              inputs: [],
            };
      if (current !== null) {
        found.push(current);
      }
      continue;
    }
    if (current === null || line.trim().length === 0) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= usesIndent) {
      // 같은 job의 다른 key(with, secrets, permissions)까지만 따라간다.
      if (!/^(with|secrets|permissions):\s*$/u.test(line.trim())) {
        current = null;
      }
      continue;
    }
    const input = /^\s+([a-z0-9_]+):/u.exec(line);
    if (input !== null) {
      current.inputs.push(input[1]);
    }
  }
  return found;
}

/**
 * 로컬 복제본에서 snapshot을 만든다. 복제본이 원격 default branch와 어긋나면 그 사실을 함께 담는다.
 * 그 어긋남을 모르고 판정하면 "이미 이관됐다"거나 "아직 안 됐다"를 자신 있게 틀리게 말한다.
 */
export function readFilesystemSnapshot(root) {
  const directory = join(root, '.github', 'workflows');
  const workflows = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith('.yml'))
        .sort()
        .map((name) => ({ path: `.github/workflows/${name}`, text: readTextOrNull(join(directory, name)) }))
        .filter(({ text }) => text !== null)
    : [];

  const files = {};
  for (const path of READ_FILES) {
    files[path] = readTextOrNull(join(root, path));
  }

  const snapshot = { source: 'filesystem', root, workflows, files, ledgerBranchPresent: null };
  try {
    snapshot.headSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    snapshot.defaultBranch = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const remote = execFileSync('git', ['-C', root, 'ls-remote', 'origin', `refs/heads/${snapshot.defaultBranch}`], {
      encoding: 'utf8',
    }).trim();
    snapshot.remoteHeadSha = remote.split('\t')[0] ?? null;
    snapshot.ledgerBranchPresent =
      execFileSync('git', ['-C', root, 'ls-remote', '--heads', 'origin', LEDGER_BRANCH], {
        encoding: 'utf8',
      }).trim().length > 0;
  } catch {
    // git을 읽지 못하면 신선도를 증명할 수 없다. 판정에서 blocking으로 드러난다.
  }
  return snapshot;
}

/** GitHub의 default branch tip에서 snapshot을 만든다. 읽기 전용이다. */
export async function readGithubSnapshot(fullName, { token, fetchImpl = fetch } = {}) {
  if (typeof token !== 'string' || token.length === 0 || /[\r\n\0]/u.test(token)) {
    throw new ReleaseAuthorityError('tag-pattern-mismatch', 'GITHUB_TOKEN이 필요하다.');
  }
  const api = async (path) => {
    const response = await fetchImpl(`https://api.github.com/repos/${fullName}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new ReleaseAuthorityError('tag-pattern-mismatch', `GitHub 조회 실패: ${path} ${response.status}`);
    }
    return response.json();
  };
  const decode = (payload) =>
    payload === null || typeof payload.content !== 'string'
      ? null
      : Buffer.from(payload.content, 'base64').toString('utf8');

  const repository = await api('');
  const listing = (await api('/contents/.github/workflows')) ?? [];
  const workflows = [];
  for (const entry of listing.filter(({ name }) => name.endsWith('.yml')).sort((a, b) => a.name.localeCompare(b.name))) {
    const text = decode(await api(`/contents/.github/workflows/${entry.name}`));
    if (text !== null) {
      workflows.push({ path: `.github/workflows/${entry.name}`, text });
    }
  }
  const files = {};
  for (const path of READ_FILES) {
    files[path] = decode(await api(`/contents/${path}`));
  }
  const ledgerRefs = (await api(`/git/matching-refs/heads/${LEDGER_BRANCH}`)) ?? [];
  const head = await api(`/commits/${repository.default_branch}`);

  return {
    source: 'github',
    defaultBranch: repository.default_branch,
    headSha: head?.sha ?? null,
    remoteHeadSha: head?.sha ?? null,
    archived: repository.archived === true,
    workflows,
    files,
    ledgerBranchPresent: ledgerRefs.length > 0,
  };
}

/** 저장소 하나의 이관 필요 항목을 판정한다. 순수 함수이며 저장소를 읽지 않는다. */
export function collectCallerMigrationInventory(snapshot, fullName, { expectedCentralSha = null } = {}) {
  const callers = [];
  const findings = [];

  for (const file of snapshot.workflows) {
    const text = file.text;
    for (const use of collectCallerUses(text)) {
      const callerKind = CALLER_KIND_BY_WORKFLOW[use.calledWorkflow];
      if (callerKind === undefined) {
        continue;
      }
      // 고정되지 않은 ref는 "기대 SHA와 다르다"가 아니라 "알 수 없다"다.
      // caller-ref-not-pinned 가 그 자체로 blocking이므로 여기서 거짓 판정을 만들지 않는다.
      const shaExpected =
        expectedCentralSha === null || use.calledWorkflowSha === null
          ? null
          : use.calledWorkflowSha === expectedCentralSha;
      callers.push({
        path: file.path,
        callerKind,
        calledWorkflow: use.calledWorkflow,
        calledWorkflowSha: use.calledWorkflowSha,
        calledWorkflowShaExpected: shaExpected,
        jobKey: use.jobKey,
      });
      if (shaExpected === false && use.calledWorkflowSha !== null) {
        findings.push({
          id: 'caller-pinned-to-superseded-sha',
          severity: 'blocking',
          path: file.path,
          detail: `${use.calledWorkflow} 호출이 이전 중앙 SHA(${use.calledWorkflowSha})에 고정돼 있다.`,
        });
      }
      if (use.calledWorkflowSha === null) {
        findings.push({
          id: 'caller-ref-not-pinned',
          severity: 'blocking',
          path: file.path,
          detail: `${use.calledWorkflow} 호출이 40자리 commit SHA로 고정되지 않았다.`,
        });
      }
      for (const input of use.inputs) {
        if (REMOVED_INPUTS.includes(input)) {
          findings.push({
            id: 'forbidden-version-input',
            severity: 'blocking',
            path: file.path,
            detail: `caller가 제거된 version 입력 ${input}을 넘긴다.`,
          });
        } else if ((OBSOLETE_INPUTS_BY_KIND[callerKind] ?? []).includes(input)) {
          findings.push({
            id: 'obsolete-caller-input',
            severity: 'blocking',
            path: file.path,
            detail: `${use.calledWorkflow}에서 제거된 입력 ${input}을 넘긴다. 러너는 중앙에서 고정한다.`,
          });
        }
      }
      if (callerKind === 'godot-deploy-google-play' && !use.inputs.includes('android_export_preset')) {
        findings.push({
          id: 'godot-export-preset-not-declared',
          severity: 'advisory',
          path: file.path,
          detail: 'export preset 이름이 Android가 아니면 android_export_preset을 명시해야 한다.',
        });
      }
    }
  }

  if (snapshot.files['scripts/resolve-release-version.mjs'] !== null) {
    findings.push({
      id: 'repository-local-version-resolver',
      severity: 'blocking',
      path: 'scripts/resolve-release-version.mjs',
      detail: '저장소 로컬 version resolver는 authority가 아니므로 제거해야 한다.',
    });
  }

  // 로컬 복제본이 원격 default branch와 다르면 pin 판별을 신뢰할 수 없다.
  if (snapshot.source === 'filesystem' && snapshot.headSha !== snapshot.remoteHeadSha) {
    findings.push({
      id: 'stale-working-tree',
      severity: 'blocking',
      path: '.git/HEAD',
      detail: `로컬 HEAD(${snapshot.headSha ?? 'unknown'})가 원격 default branch(${snapshot.remoteHeadSha ?? 'unknown'})와 다르다.`,
    });
  }

  const kinds = new Set(callers.map(({ callerKind }) => callerKind));
  const marketKinds = ['rn-deploy-google-play', 'godot-deploy-google-play', 'rn-deploy-ait', 'godot-deploy-ait'];
  if (marketKinds.some((kind) => kinds.has(kind)) && !kinds.has('release-tag')) {
    // 원장은 태그 생성 경로에서만 갱신된다. 그 caller가 없으면 이 저장소는 원장을 채울 수 없다.
    findings.push({
      id: 'release-tag-caller-missing',
      severity: 'blocking',
      path: '.github/workflows',
      detail: '마켓 배포 caller는 있는데 release-tag caller가 없어 원장을 채울 경로가 없다.',
    });
  }
  if (kinds.has('release-tag') && !kinds.has('init-release-version-ledger')) {
    findings.push({
      id: 'ledger-caller-missing',
      severity: 'blocking',
      path: '.github/workflows/init-release-version-ledger.yml',
      detail: '원장 초기화 caller가 없다. 원장 없이는 번호를 할당할 수 없다.',
    });
  }
  if (kinds.has('release-tag') && snapshot.ledgerBranchPresent === false) {
    findings.push({
      id: 'ledger-branch-missing',
      severity: 'blocking',
      path: `refs/heads/${LEDGER_BRANCH}`,
      detail: '원장 브랜치가 없다. init-release-version-ledger로 먼저 초기화해야 한다.',
    });
  }

  for (const [path, keys] of [
    ['play-store/google-play.config.json', ['versionName', 'versionCode']],
    ['app-store/app-store.config.json', ['version']],
  ]) {
    const text = snapshot.files[path];
    if (text === null || text === undefined) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const release = parsed?.release ?? {};
    for (const key of keys) {
      if (release[key] !== undefined) {
        findings.push({
          id: 'market-config-version-authority',
          severity: 'blocking',
          path: `${path}#release.${key}`,
          detail: '마켓 config JSON은 version authority가 아니므로 값을 제거해야 한다.',
        });
      }
    }
  }

  findings.sort((left, right) =>
    `${left.id}${left.path}`.localeCompare(`${right.id}${right.path}`),
  );

  const repository = {
    fullName,
    source: snapshot.source,
    defaultBranch: snapshot.defaultBranch ?? null,
    headSha: snapshot.headSha ?? null,
    remoteHeadSha: snapshot.remoteHeadSha ?? null,
    ledgerBranchPresent: snapshot.ledgerBranchPresent,
  };
  if (snapshot.root !== undefined) {
    repository.root = snapshot.root;
  }

  return {
    schemaVersion: 2,
    authority: AUTHORITY_ID,
    migration: MIGRATION_ID,
    expectedCentralSha,
    repository,
    callers,
    findings,
    status: findings.some(({ severity }) => severity === 'blocking') ? 'NEEDS_CHANGE' : 'READY',
  };
}

/** 정책 계약에서 순회 대상 저장소 목록을 뽑는다. 이관 대상 판정은 여전히 패턴이 한다. */
export function extractPolicyRepositories(policyText) {
  return [...String(policyText ?? '').matchAll(/^ {2}- repository: ([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/gmu)].map(
    (match) => match[1],
  );
}

/** 저장소별 이관 상태를 한 장으로 모은다. 모든 저장소가 셋 중 하나로 분류돼야 한다. */
export function summarizeFleet(entries, { expectedCentralSha, observedAt }) {
  const repositories = entries
    .map(({ fullName, inventory, archived }) => {
      const blocking = inventory.findings.filter(({ severity }) => severity === 'blocking').map(({ id }) => id);
      const kinds = new Set(inventory.callers.map(({ callerKind }) => callerKind));
      if (archived === true) {
        return { fullName, state: 'EXCLUDED', pullRequest: null, exclusionReason: 'archived-repository' };
      }
      if (inventory.callers.length === 0) {
        return { fullName, state: 'EXCLUDED', pullRequest: null, exclusionReason: 'no-central-caller' };
      }
      if (!kinds.has('release-tag')) {
        return {
          fullName,
          state: 'EXCLUDED',
          pullRequest: null,
          exclusionReason: 'no-central-release-tag-caller',
          detail: '중앙 release-tag caller가 없어 원장을 채울 경로가 없다.',
        };
      }
      if (inventory.status === 'READY') {
        return { fullName, state: 'MIGRATED', pullRequest: null };
      }
      return { fullName, state: 'PENDING', pullRequest: null, blocking: [...new Set(blocking)].sort() };
    })
    .sort((left, right) => left.fullName.localeCompare(right.fullName));

  const count = (state) => repositories.filter((row) => row.state === state).length;
  return {
    schemaVersion: 1,
    authority: AUTHORITY_ID,
    migration: MIGRATION_ID,
    expectedCentralSha,
    observedAt,
    repositories,
    summary: { migrated: count('MIGRATED'), pending: count('PENDING'), excluded: count('EXCLUDED') },
    status: count('PENDING') > 0 ? 'NEEDS_CHANGE' : 'READY',
  };
}

function parseCli(argv) {
  const options = { source: 'github', fleet: false, expectedCentralSha: null, out: '' };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--fleet') {
      options.fleet = true;
    } else if (argument.startsWith('--')) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ReleaseAuthorityError('tag-pattern-mismatch', `${argument} 값이 없다.`);
      }
      index += 1;
      if (argument === '--full-name') options.fullName = value;
      else if (argument === '--source') options.source = value;
      else if (argument === '--expected-central-sha') options.expectedCentralSha = value;
      else if (argument === '--repositories-from') options.repositoriesFrom = value;
      else if (argument === '--out') options.out = value;
      else throw new ReleaseAuthorityError('tag-pattern-mismatch', `알 수 없는 인자: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (options.expectedCentralSha !== null && !/^[0-9a-f]{40}$/u.test(options.expectedCentralSha)) {
    throw new ReleaseAuthorityError('tag-pattern-mismatch', '--expected-central-sha는 40자리 hex여야 한다.');
  }
  return { options, positional };
}

async function snapshotFor(target, options) {
  if (options.source === 'filesystem') {
    const root = resolve(target);
    return { fullName: options.fullName ?? `seorilabs/${basename(root)}`, snapshot: readFilesystemSnapshot(root) };
  }
  const fullName = /\//u.test(target) ? target : `seorilabs/${basename(resolve(target))}`;
  return { fullName, snapshot: await readGithubSnapshot(fullName, { token: process.env.GITHUB_TOKEN ?? '' }) };
}

async function main() {
  const { options, positional } = parseCli(process.argv.slice(2));
  const observedAt = new Date().toISOString().replace(/\.\d+Z$/u, 'Z');

  let report;
  if (options.fleet) {
    if (options.repositoriesFrom === undefined) {
      throw new ReleaseAuthorityError('tag-pattern-mismatch', '--fleet 에는 --repositories-from 이 필요하다.');
    }
    const names = extractPolicyRepositories(readFileSync(options.repositoriesFrom, 'utf8'));
    const entries = [];
    for (const fullName of names) {
      const snapshot = await readGithubSnapshot(fullName, { token: process.env.GITHUB_TOKEN ?? '' });
      entries.push({
        fullName,
        archived: snapshot.archived,
        inventory: collectCallerMigrationInventory(snapshot, fullName, {
          expectedCentralSha: options.expectedCentralSha,
        }),
      });
    }
    report = summarizeFleet(entries, { expectedCentralSha: options.expectedCentralSha, observedAt });
  } else {
    if (positional[0] === undefined) {
      throw new ReleaseAuthorityError('tag-pattern-mismatch', '저장소 경로 또는 owner/repo가 필요하다.');
    }
    const { fullName, snapshot } = await snapshotFor(positional[0], options);
    report = collectCallerMigrationInventory(snapshot, fullName, {
      expectedCentralSha: options.expectedCentralSha,
    });
  }

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out.length > 0) {
    writeFileSync(options.out, serialized, 'utf8');
  }
  process.stdout.write(serialized);
  return report.status === 'READY' ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
