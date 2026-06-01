// 자식 실패 사유가 "일시적"(재시도하면 풀릴 만한 것)인지 판정한다.
// rate limit, 과부하, 타임아웃, 네트워크 깜빡임, 5xx, 연결 리셋 등은 transient.
// 잘못된 인자/인증 실패/모델 없음 같은 결정적 오류는 false (재시도해도 똑같이 실패).
//
// 별도 모듈인 이유: index.ts 는 class parameter property 를 써서 node 의 strip-only
// 실행(harness)에서 import 불가. 이 순수 함수만 떼어내 테스트 가능하게 둔다.
export function isTransientError(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  // 결정적 오류는 재시도 안 함.
  if (
    /unknown option|invalid (model|argument|input)|no such|not found|unauthorized|forbidden|401|403|invalid api key|missing api key/.test(
      e,
    )
  ) {
    return false;
  }
  return /rate.?limit|429|overload|capacity|too many requests|timeout|timed out|etimedout|econnreset|econnrefused|enetunreach|socket hang up|network|temporarily|unavailable|503|502|504|500|server error|stream (error|closed)|reset by peer/.test(
    e,
  );
}
