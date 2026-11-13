# GitHub 실패 로그 요청 헤더 수정

Android 업로드 전 readonly 검사가 GitHub job logs의 HTTP415에서 멈췄다. `githubDownload` 기본값인 application/octet-stream을 해당 endpoint가 허용하지 않았다. 보고서·업로드 예약은 생성되지 않았고 실제 업로드도0회다.

이 endpoint에 application/vnd.github+json을 명시한다. 응답은 JSON으로 변환하지 않고 원래 로그 바이트를 그대로 받으며, 승인한 원래 로그 SHA-256 대조를 유지한다. 실패를 면제하거나 source·artifact·서명·한도·만료를 바꾸지 않는다. 추가 native0회이며 제품source/태그는 그대로다.

HTTP415를 재현하는 테스트를 먼저 실패시킨 뒤 수정했다. 헤더와 ANSI를 포함한 raw 바이트 보존 테스트 및 전체2,088개 로컬 테스트가 통과했다. 실제 job131906522643의 로그를 수정한 헤더로 읽어 고정 digest1301935252299d54f2fc0d451b1f6560efa68d0425b92185e637303403486c01과 비교한다. 코드 검토 후 Google grant의 verifier revision만 별도 메타데이터 PR에서 연결한다. Apple은 먼저 검증한 기존 revision에서 진행하며 변경하지 않는다.
