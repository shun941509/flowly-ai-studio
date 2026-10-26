/** 실행 요청의 중복 여부를 판정하는 정규화 해시. 암호화나 사용자 인증 수단으로 사용하지 않는다. */
/** 객체 키만 정렬하고 배열 순서는 보존한다. 정규화 규칙 변경은 기존 idempotencyKey의 요청 비교에 영향을 준다. */
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** 같은 요청 키에 다른 모드·입력·설계를 재사용했는지 확인할 SHA-256 지문을 반환한다. */
export async function hashRequest(value:unknown) {return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical(value))))).map(b=>b.toString(16).padStart(2,"0")).join("");}
