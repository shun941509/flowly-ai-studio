/**
 * Worker 환경에서 사용할 수 있는 선택적 D1/R2 바인딩의 타입 선언. 바인딩이 실제로 준비됐다는 보장은 런타임 어댑터에서 확인한다.
 */
declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
