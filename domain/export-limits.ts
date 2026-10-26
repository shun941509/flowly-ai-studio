/**
 * 내보내기 사전 검사와 서버 패키지 생성이 함께 사용하는 자료·연결 수 제한.
 * 한쪽만 변경하면 화면에서는 통과하지만 패키지 생성에서 실패할 수 있으므로 함께 검증한다.
 */
/** Shared by web preflight, package generation and the Node export reader. */
export const MAX_EXPORT_RESOURCES = 100;
export const MAX_EXPORT_CONNECTIONS = 100;
