/**
 * 체험 워크스페이스 진입점. 고정된 체험 사용자와 demo 플래그로 로컬 데모 저장 흐름을 선택한다.
 */
import { Studio } from "../ui/studio";
export default function DemoPage(){return <Studio demo user={{userId:"demo",email:"demo@flowly.example",displayName:"체험 사용자"}} signOutUrl="/"/>;}
