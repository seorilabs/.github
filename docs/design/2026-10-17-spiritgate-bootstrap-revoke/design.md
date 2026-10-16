# 종료한 Spiritgate 첫 내부1.1.0 grant 폐기

사용자가 승인한 1.1.1 정상 v2/L3 복구에 따라 기존 first-internal grant의 revoked 값만 true로 바꾼다. 태그·소스·실패·만료·원문 해시와 정상 계약을 유지한다. 폐기 전후 메타데이터 외 변경을 대조하고 기존 revoked grant 및 current-main 재검증 검사를 실행한다. 새로운 예외·빌드·서명 자원·기간 변경은 포함하지 않는다.

단순 폐기 메타데이터이므로 review-policy의 메타데이터 예외를 적용한다. 기존 일반/공급자 검증 테스트와 required check를 통과한 뒤 병합한다. 제품 실행이 없는 중앙 메타데이터 변경으로 가짜 제품 실행 기록은 만들지 않는다.
