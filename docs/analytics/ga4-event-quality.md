# GA4 event quality contract

[`analytics-event-policy.yaml`](../../contracts/analytics-event-policy.yaml)은 앱의 custom event와 GA4 원시 export를 같은 차원으로 읽기 위한 조직 계약이다. Firebase 자동 이벤트에는 custom parameter를 강제하지 않는다.

## Custom event

각 앱의 Analytics 어댑터는 custom event를 보내기 직전에 아래 문자열을 자동 병합한다.

- `app_market`: `google_play`, `app_store`, `apps_in_toss`
- `runtime_platform`: `android`, `ios`, `web`
- `release_version`: [`release-version-authority.yaml`](../../contracts/release-version-authority.yaml)이 정한 태그 또는 빌드 버전

앱이 같은 동작을 Firebase SDK와 Platform relay에 동시에 보내면 안 된다. Firebase 자동 이벤트는 이 규칙의 대상이 아니다.

## 모바일 전송과 수집 확인

Android·iOS 제품 이벤트는 각각 등록된 Firebase 앱의 Analytics SDK를 통해 GA4 앱 스트림으로 전송한다. 앱 설정의 수집 동의와 SDK의 수집·저장 동의를 함께 적용한다. Platform 이벤트 수집 경로는 운영 진단 등 별도 목적에만 사용하고, 같은 제품 동작을 중계하지 않는다. Measurement Protocol은 SDK 이벤트를 보완하는 서버 이벤트에만 사용하며, 앱 이벤트를 보낼 때는 SDK가 발급한 앱 인스턴스 ID를 사용한다.

완료 상태는 세 단계로 구분한다.

1. Android·iOS 앱 ID와 설치 빌드에 포함된 설정·SDK를 대조한다.
2. 실기기에서 한 동작을 일으켜 DebugView 또는 실시간 보고서에서 해당 앱 스트림의 이벤트를 확인한다.
3. BigQuery export에서 같은 이벤트의 stream·platform·geo·first-touch 값을 읽고, 동일 동작의 중복 전송이 없는지 확인한다. 아직 export 시점이 오지 않았으면 이 단계는 미확인으로 둔다.

이 기준은 신규·변경 앱에 적용한다. 기존 앱의 전송 경로를 일괄 변경했다는 뜻은 아니다.

## BigQuery 정규화

정규화 view는 값과 출처를 함께 노출한다. `dimension_source`는 `app_market`, `runtime_platform`, `release_version`, `country`별로 `observed`, `legacy`, `inferred`, `unknown` 중 하나를 가진 구조체다.

우선순위는 다음과 같다.

1. canonical event parameter를 `observed`로 사용한다.
2. `market`, `platform`, `app_version`과 canonical key에 남은 구형 값은 `legacy`로 정규화한다.
3. 자동 이벤트는 `install_source` 또는 중앙에서 exact하게 매핑한 stream, 최상위 `platform`, `app_info.version`을 `inferred`로 사용한다.
4. 근거가 없으면 문자열 차원은 `unknown`, 국가는 `NULL`로 유지하고 출처를 `unknown`으로 기록한다.

최상위 `platform=WEB`만 보고 `apps_in_toss`를 추정하거나 누락된 국가를 임의로 생성하는 것은 금지한다. 이 규칙의 재사용 가능한 기준 구현은 `normalizeAnalyticsDimensions`다. `renderGa4NormalizedSelect`는 provider 쓰기를 하지 않고 view 본문으로 사용할 표준 SQL `SELECT`만 만들며, 중앙 ConfigRevision과 provider observation이 제공한 exact stream 매핑만 받는다.

`archived`와 소유권이 `unknown`인 앱은 쓰기 계획에서 제외한다. 읽기 전용 감사 결과는 별도로 보존할 수 있다.

## 읽기 전용 관리 계획

`plan-ga4-readiness.mjs`는 원하는 상태와 provider readback JSON을 비교할 뿐 API 쓰기를 실행하지 않는다.

```bash
node scripts/analytics/plan-ga4-readiness.mjs \
  --desired /path/to/config-revision-projection.json \
  --observed /path/to/provider-observation.json
```

두 입력의 `checks`에는 계약에 정의된 일곱 check가 들어간다. observation은 `state=present|absent|unknown`과 `present`일 때의 `value`를 가진다.

- `present`: exact match
- `planned`: provider가 부재를 확정해 후속 쓰기 계획이 필요함
- `unknown`: readback 실패, 권한 부족, 또는 desired 상태 부재
- `mismatch`: provider 리소스가 있으나 원하는 상태와 다름

이 출력은 Console 설정, ConfigRevision 생성·활성화, 배포 또는 실제 GA4 수집 성공을 뜻하지 않는다. Measurement Protocol의 HTTP 2xx도 수집 완료 증거가 아니다.
