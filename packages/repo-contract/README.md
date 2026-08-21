# @seorilabs/repo-contract

Seorilabs 앱 저장소의 선언과 필수 파일을 조직 계약으로 검증하는 Node.js 24 CLI입니다. 배포 패키지에는 검증에 사용한 `contracts/`와 `profiles/` 스냅샷이 함께 포함됩니다.

```bash
repo-contract [저장소 경로]
```

저장소 경로를 생략하면 현재 디렉터리를 검사합니다. 기본 manifest는 `<저장소>/.seorilabs/app.yaml`입니다.

- 종료 코드 `0`: 모든 계약 통과
- 종료 코드 `1`: 문서 파싱, 스키마, 의미 또는 필수 파일 계약 실패
- 종료 코드 `2`: 잘못된 CLI 사용법

진단은 문서명, JSON path, 고정 오류 코드만 표시하며 자격증명 값을 출력하지 않습니다.

React Native monorepo는 `sdk.consumers`에 실제 SDK를 import하는 각 `package.json`과 대응하는 pnpm lockfile importer를 선언합니다. 검증기는 모든 consumer의 정확한 package 버전과 lockfile resolution, GitHub Packages tarball, SHA-512 integrity를 확인합니다.

Godot `SOURCE`는 `VERSION`과 같은 tag의 `seorilabs/platform` GitHub release URL이어야 합니다. `CHECKSUM`은 `profiles/godot.yaml`의 `vendored-tree-v1` 규칙으로 계산합니다. SDK 루트의 `CHECKSUM`만 제외하고 `SOURCE`, `VERSION`, 일반 파일의 상대 경로와 내용을 순서대로 해시하며 symlink는 허용하지 않습니다.
