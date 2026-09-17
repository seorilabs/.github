import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveReleaseNotes } from '../scripts/release/resolve-release-notes.mjs';

const TOKEN = 'ghs_canary_token_value';
const ENV = { GH_TOKEN: TOKEN, GITHUB_API_URL: 'https://api.github.com' };
const NOTES_DOCUMENT = {
  schema: 'seorilabs.release-notes/v2',
  version: '1.0.32',
  notes: { 'ko-KR': '- 첫 줄\n', 'en-US': '- first line\n' },
};

function response({ status = 200, body = '', headers = {} } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async json() {
      return JSON.parse(bytes.toString('utf8'));
    },
    async text() {
      return bytes.toString('utf8');
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) {
        return typeof handler === 'function' ? handler(url, init) : handler;
      }
    }
    return response({ status: 404, body: '{"message":"Not Found"}' });
  };
  return { fetchImpl, calls };
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'release-notes-'));
  try {
    return await run(join(dir, 'release-notes.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const RELEASE_WITH_ASSET = response({
  body: JSON.stringify({ assets: [{ id: 77, name: 'release-notes.json' }] }),
});

test('Release가 없는 태그는 자산도 없으므로 노트 없이 진행한다', async () => {
  await withTempDir(async (outputPath) => {
    const { fetchImpl } = stubFetch([['/releases/tags/', response({ status: 404, body: '{}' })]]);
    const result = await resolveReleaseNotes({
      repository: 'seorilabs/saju-reader',
      tag: 'v1.0.32',
      outputPath,
      env: ENV,
      fetchImpl,
      log: () => {},
    });
    assert.deepEqual(result, { found: false, reason: 'release-not-found' });
    await assert.rejects(() => stat(outputPath));
  });
});

test('Release는 있고 자산만 없으면 노트 없이 진행한다', async () => {
  await withTempDir(async (outputPath) => {
    const { fetchImpl } = stubFetch([
      ['/releases/tags/', response({ body: JSON.stringify({ assets: [{ id: 1, name: 'app.aab' }] }) })],
    ]);
    const result = await resolveReleaseNotes({
      repository: 'seorilabs/saju-reader',
      tag: 'v1.0.32',
      outputPath,
      env: ENV,
      fetchImpl,
      log: () => {},
    });
    assert.deepEqual(result, { found: false, reason: 'asset-not-attached' });
  });
});

// #166의 핵심. 예전 구현은 gh 부재(exit 127)를 `2>/dev/null`로 지우고 "자산 없음"처럼 넘겼다.
test('자산이 붙어 있는데 받지 못하면 멈춘다', async () => {
  await withTempDir(async (outputPath) => {
    const { fetchImpl } = stubFetch([
      ['/releases/tags/', RELEASE_WITH_ASSET],
      ['/releases/assets/77', response({ status: 403, body: '{"message":"Forbidden"}' })],
    ]);
    await assert.rejects(
      () =>
        resolveReleaseNotes({
          repository: 'seorilabs/saju-reader',
          tag: 'v1.0.32',
          outputPath,
          env: ENV,
          fetchImpl,
          log: () => {},
        }),
      (error) => {
        assert.match(error.message, /HTTP 403/u);
        assert.doesNotMatch(error.message, new RegExp(TOKEN, 'u'));
        return true;
      },
    );
    await assert.rejects(() => stat(outputPath));
  });
});

test('자산이 JSON이 아니면 멈춘다', async () => {
  await withTempDir(async (outputPath) => {
    const { fetchImpl } = stubFetch([
      ['/releases/tags/', RELEASE_WITH_ASSET],
      ['/releases/assets/77', response({ body: 'not json' })],
    ]);
    await assert.rejects(
      () =>
        resolveReleaseNotes({
          repository: 'seorilabs/saju-reader',
          tag: 'v1.0.32',
          outputPath,
          env: ENV,
          fetchImpl,
          log: () => {},
        }),
      /JSON으로 읽히지 않는다/u,
    );
  });
});

test('자산은 있는데 notes가 비어 있으면 멈춘다', async () => {
  await withTempDir(async (outputPath) => {
    const { fetchImpl } = stubFetch([
      ['/releases/tags/', RELEASE_WITH_ASSET],
      ['/releases/assets/77', response({ body: JSON.stringify({ notes: {} }) })],
    ]);
    await assert.rejects(
      () =>
        resolveReleaseNotes({
          repository: 'seorilabs/saju-reader',
          tag: 'v1.0.32',
          outputPath,
          env: ENV,
          fetchImpl,
          log: () => {},
        }),
      /notes가 비어 있다/u,
    );
  });
});

test('정상 자산은 받은 바이트 그대로 기록한다', async () => {
  await withTempDir(async (outputPath) => {
    const raw = JSON.stringify(NOTES_DOCUMENT);
    const { fetchImpl } = stubFetch([
      ['/releases/tags/', RELEASE_WITH_ASSET],
      ['/releases/assets/77', response({ body: raw })],
    ]);
    const result = await resolveReleaseNotes({
      repository: 'seorilabs/saju-reader',
      tag: 'v1.0.32',
      outputPath,
      env: ENV,
      fetchImpl,
      log: () => {},
    });
    assert.equal(result.found, true);
    assert.equal(result.locales, 2);
    assert.equal(result.schema, 'seorilabs.release-notes/v2');
    assert.equal(await readFile(outputPath, 'utf8'), raw);
  });
});

// 자산 본문은 스토리지로 302된다. Authorization을 그대로 들고 가면 스토리지가 거부한다.
test('자산 리다이렉트를 따라갈 때 Authorization을 전달하지 않는다', async () => {
  await withTempDir(async (outputPath) => {
    const raw = JSON.stringify(NOTES_DOCUMENT);
    const { fetchImpl, calls } = stubFetch([
      ['/releases/tags/', RELEASE_WITH_ASSET],
      [
        '/releases/assets/77',
        response({ status: 302, headers: { location: 'https://objects.example/blob' } }),
      ],
      ['https://objects.example/blob', response({ body: raw })],
    ]);
    const result = await resolveReleaseNotes({
      repository: 'seorilabs/saju-reader',
      tag: 'v1.0.32',
      outputPath,
      env: ENV,
      fetchImpl,
      log: () => {},
    });
    assert.equal(result.found, true);

    const assetCall = calls.find(({ url }) => url.includes('/releases/assets/77'));
    assert.equal(assetCall.init.redirect, 'manual');
    assert.match(assetCall.init.headers.authorization, /^Bearer /u);

    const storageCall = calls.find(({ url }) => url === 'https://objects.example/blob');
    assert.equal(storageCall.init.headers.authorization, undefined);
  });
});

test('인증 실패는 자산 없음으로 오판하지 않는다', async () => {
  await withTempDir(async (outputPath) => {
    const { fetchImpl } = stubFetch([
      ['/releases/tags/', response({ status: 401, body: '{"message":"Bad credentials"}' })],
    ]);
    await assert.rejects(
      () =>
        resolveReleaseNotes({
          repository: 'seorilabs/saju-reader',
          tag: 'v1.0.32',
          outputPath,
          env: ENV,
          fetchImpl,
          log: () => {},
        }),
      /HTTP 401/u,
    );
  });
});

test('저장소·태그·출력 경로가 없으면 요청 전에 멈춘다', async () => {
  const never = () => {
    throw new Error('요청이 나가면 안 된다.');
  };
  await assert.rejects(
    () => resolveReleaseNotes({ repository: 'nope', tag: 'v1', outputPath: '/tmp/x', env: ENV, fetchImpl: never }),
    /owner\/name이 아니다/u,
  );
  await assert.rejects(
    () =>
      resolveReleaseNotes({
        repository: 'seorilabs/saju-reader',
        tag: '',
        outputPath: '/tmp/x',
        env: ENV,
        fetchImpl: never,
      }),
    /릴리스 태그가 필요하다/u,
  );
});
