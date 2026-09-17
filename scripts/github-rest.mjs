// 조직 공용 GitHub REST 클라이언트.
//
// ARC 러너 이미지에는 gh CLI가 없다(`runner-node24.Dockerfile`, `runner-android-x64.Dockerfile`
// 어디에도 설치 단계가 없다). 그래서 워크플로 스텝의 GitHub 조작은 gh 대신 Node 전역 fetch로
// 한다. 러너 이미지에 도구를 추가하지 않아도 닫히는 경로라 이 모듈이 조직 관례다.
//
// 실패를 삼키지 않는 것이 이 모듈의 존재 이유다. 호출자가 `2>/dev/null` 로 사유를 버리면
// 「자산이 없다」와 「자산은 있는데 못 읽었다」를 가릴 수 없다.
const API_VERSION = '2022-11-28';
const ERROR_BODY_LIMIT = 200;

export class GitHubRestError extends Error {
  constructor(message, { status = 0, url = '' } = {}) {
    super(message);
    this.name = 'GitHubRestError';
    this.status = status;
    this.url = url;
  }
}

export function githubApiBaseUrl(env = process.env) {
  const base = typeof env.GITHUB_API_URL === 'string' && env.GITHUB_API_URL.length > 0
    ? env.GITHUB_API_URL
    : 'https://api.github.com';
  return base.replace(/\/+$/u, '');
}

export function resolveToken(explicit, env = process.env) {
  const token = explicit ?? env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '';
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (trimmed.length === 0) {
    throw new GitHubRestError('GitHub 토큰이 없다. GH_TOKEN 또는 GITHUB_TOKEN이 필요하다.');
  }
  return trimmed;
}

function absoluteUrl(path, env) {
  return /^https?:\/\//u.test(path) ? path : `${githubApiBaseUrl(env)}${path}`;
}

// 토큰 값은 어떤 메시지에도 넣지 않는다. 남기는 것은 method/url/status와 잘린 본문뿐이다.
async function describeFailure(response, url, method) {
  let body = '';
  try {
    body = (await response.text()).trim().replace(/\s+/gu, ' ').slice(0, ERROR_BODY_LIMIT);
  } catch {
    body = '(본문을 읽지 못했다)';
  }
  return new GitHubRestError(
    `GitHub REST ${method} ${url} 실패: HTTP ${response.status}${body.length > 0 ? ` ${body}` : ''}`,
    { status: response.status, url },
  );
}

export async function githubRequest(path, options = {}) {
  const {
    token,
    method = 'GET',
    accept = 'application/vnd.github+json',
    redirect = 'follow',
    env = process.env,
    fetchImpl = globalThis.fetch,
  } = options;
  const url = absoluteUrl(path, env);
  const response = await fetchImpl(url, {
    method,
    redirect,
    headers: {
      accept,
      authorization: `Bearer ${resolveToken(token, env)}`,
      'user-agent': 'seorilabs-github-rest',
      'x-github-api-version': API_VERSION,
    },
  });
  return { response, url, method };
}

export async function githubJson(path, options = {}) {
  const { response, url, method } = await githubRequest(path, options);
  if (!response.ok) {
    throw await describeFailure(response, url, method);
  }
  try {
    return await response.json();
  } catch {
    throw new GitHubRestError(`GitHub REST ${method} ${url} 응답이 JSON이 아니다.`, {
      status: response.status,
      url,
    });
  }
}

// 본문을 돌려주지 않는 요청(DELETE는 204)용. 성공 여부만 보고 본문은 버린다.
export async function githubVoid(path, options = {}) {
  const { response, url, method } = await githubRequest(path, options);
  if (!response.ok) {
    throw await describeFailure(response, url, method);
  }
}

function nextPageUrl(response) {
  const link = response.headers?.get?.('link');
  if (typeof link !== 'string' || link.length === 0) {
    return '';
  }
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/u);
    if (match) {
      return match[1];
    }
  }
  return '';
}

// gh api --paginate 대체. Link 헤더의 rel="next"만 따라간다.
export async function githubPaginate(path, options = {}) {
  const { select = (page) => page, maxPages = 100 } = options;
  const pages = [];
  let target = path;
  for (let index = 0; index < maxPages && target.length > 0; index += 1) {
    const { response, url, method } = await githubRequest(target, options);
    if (!response.ok) {
      throw await describeFailure(response, url, method);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new GitHubRestError(`GitHub REST ${method} ${url} 응답이 JSON이 아니다.`, {
        status: response.status,
        url,
      });
    }
    const items = select(payload);
    if (Array.isArray(items)) {
      pages.push(...items);
    }
    target = nextPageUrl(response);
  }
  return pages;
}

// Release asset 은 302로 스토리지에 넘긴다. 리다이렉트를 자동으로 따라가면 Authorization 헤더가
// 스토리지까지 따라가 403으로 거부될 수 있다. 수동으로 받아 Location에는 인증을 붙이지 않는다.
export async function githubDownload(path, options = {}) {
  const { env = process.env, fetchImpl = globalThis.fetch } = options;
  const { response, url, method } = await githubRequest(path, {
    ...options,
    accept: 'application/octet-stream',
    redirect: 'manual',
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers?.get?.('location') ?? '';
    if (location.length === 0) {
      throw new GitHubRestError(`GitHub REST ${method} ${url} 리다이렉트에 Location이 없다.`, {
        status: response.status,
        url,
      });
    }
    const followed = await fetchImpl(location, {
      method: 'GET',
      redirect: 'follow',
      headers: { accept: 'application/octet-stream', 'user-agent': 'seorilabs-github-rest' },
    });
    if (!followed.ok) {
      throw await describeFailure(followed, '(release asset storage)', method);
    }
    return Buffer.from(await followed.arrayBuffer());
  }

  if (!response.ok) {
    throw await describeFailure(response, url, method);
  }
  return Buffer.from(await response.arrayBuffer());
}

export { absoluteUrl as githubAbsoluteUrl, API_VERSION as GITHUB_API_VERSION };
