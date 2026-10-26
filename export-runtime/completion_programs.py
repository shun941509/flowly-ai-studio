# 기술 예제의 제약/근거/비교/관계 검색/아바타 지시용 결정적 JSON 프로그램. 모델 판단과 측정 결과를 분리한다.
"""Bounded, deterministic technical workflow programs. No network, filesystem or code execution."""
from __future__ import annotations
import copy
import hashlib
import itertools
import json
import math
import re
import html
import ast
from datetime import datetime, timezone


def bounded(value):
    def walk(v, depth=0):
        if depth > 15:
            raise ValueError("자료 중첩 한도를 넘었어요.")
        if isinstance(v, dict):
            if len(v) > 200 or any(k in ("__proto__", "constructor", "prototype") for k in v):
                raise ValueError("자료 키를 확인해 주세요.")
            for item in v.values(): walk(item, depth+1)
        elif isinstance(v, list):
            if len(v) > 2000: raise ValueError("목록은 2,000개 이하여야 해요.")
            for item in v: walk(item, depth+1)
        elif isinstance(v, float) and not math.isfinite(v):
            raise ValueError("유한한 수치가 필요해요.")
    walk(value)
    if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf8")) > 1_000_000:
        raise ValueError("자료는 1MB 이하여야 해요.")
    return value


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def num(value):
    if type(value) not in (int, float) or not math.isfinite(value): raise ValueError("유한한 숫자가 필요해요.")
    return value


# 조합은 최대 4,096개까지 확인한다. repair는 위반 조건에 관련된 필드만 바꾼다.
def constraints(a):
    domains, rules = dict(sorted(a["domains"].items())), a["rules"]
    if not 1 <= len(domains) <= 6 or math.prod(len(v) for v in domains.values()) > 4096:
        raise ValueError("후보 조합은 4,096개 이하여야 해요.")
    def violations(candidate):
        missing = [key for key in domains if key not in candidate or candidate[key] not in domains[key]]
        errors = ["domain:"+key for key in missing]
        if missing: return errors
        for rule in rules:
            values = [num(candidate[key]) for key in rule["fields"]]
            observed = sum(values) if rule["kind"] == "sum" else values[0]-values[1] if rule["kind"] == "difference" else None
            if observed is None: raise ValueError("허용 제약은 sum/difference예요.")
            if not num(rule["min"]) <= observed <= num(rule["max"]): errors.append(rule["id"])
        return errors
    candidate = a.get("candidate", {})
    errors = violations(candidate)
    if a.get("mode", "check") == "check": return {"passed": not errors, "violations": errors, "candidate": candidate}
    mutable = {field for rule in rules if rule["id"] in errors for field in rule["fields"]} | {key for key in domains if "domain:"+key in errors}
    for values in itertools.product(*domains.values()):
        trial = dict(zip(domains, values))
        if a.get("mode") == "repair" and any(trial[k] != candidate[k] for k in candidate if k not in mutable): continue
        if not violations(trial): return {"passed": True, "status": "solved", "candidate": trial, "violations": [], "changedFields": [k for k in trial if candidate.get(k) != trial[k]]}
    return {"passed": False, "status": "impossible", "candidate": candidate, "violations": errors, "enumerated": math.prod(len(v) for v in domains.values())}


def sensitivity(a):
    base = a["base"]
    def calculate(row): return num(row["volume"])*num(row["unitCost"])+num(row["fixedCost"])
    baseline = calculate(base); trials=[]
    for variable, values in a["ranges"].items():
        if variable not in base or len(values)>20: raise ValueError("등록 변수 범위를 확인해 주세요.")
        for value in values:
            state={**base, variable:num(value)}; result=calculate(state)
            trials.append({"variable":variable,"value":value,"result":result,"delta":result-baseline})
    ranked=sorted(trials,key=lambda x:abs(x["delta"]),reverse=True)
    return {"baseline":baseline,"trials":trials,"largestImpact":ranked[0] if ranked else None,"formula":"volume * unitCost + fixedCost","passed":bool(trials)}


# 인용 ID/원문 포함 여부를 검사한다. 인용 문장의 진실성 전체를 보증하는 검사는 아니다.
def coverage(a):
    expected=set(a["expectedIds"]); covered=set(); invalid=[]
    sources={v["id"]:v["text"] for v in a["sources"]}
    for summary in a["summaries"]:
        for citation in summary["citations"]:
            if citation["sourceId"] not in sources or not citation["quote"] or citation["quote"] not in sources[citation["sourceId"]]: invalid.append(citation)
            else: covered.add(citation["sourceId"])
    return {"passed":not invalid and expected<=covered,"missingIds":sorted(expected-covered),"invalidCitations":invalid,"coveredIds":sorted(covered),"summaries":a["summaries"]}


def cross_modal(a):
    observations={v["regionId"]:v for v in a["observations"]}; checks=[]
    for claim in a["claims"]:
        observed=observations.get(claim["regionId"])
        status="unverified" if not observed or observed.get("confidence",0)<a.get("minimumConfidence",.8) else "matched" if observed["label"]==claim["label"] and observed["count"]==claim["count"] else "contradiction"
        checks.append({"documentPosition":claim["position"],"regionId":claim["regionId"],"status":status,"observation":observed})
    return {"passed":all(c["status"]=="matched" for c in checks),"checks":checks,"semanticExtractorRequired":True}


def events(a):
    seen=set(a.get("seenIds",[])); unique=[]; duplicates=[]
    for e in sorted(a["events"],key=lambda e:e["time"]):
        if e["id"] in seen: duplicates.append(e["id"])
        else: seen.add(e["id"]);unique.append(e)
    history=[*a.get("history",[]),*unique]
    incidents=[];new_ids={e["id"] for e in unique}
    for key in sorted({e["correlationKey"] for e in unique}):
        group=sorted([e for e in history if e["correlationKey"]==key],key=lambda e:e["time"])
        for right in group:
            if right["id"] not in new_ids:continue
            window=[e for e in group if right["time"]-a["windowSeconds"]<=e["time"]<=right["time"]]
            if len(window)>=a["threshold"]:
                incidents.append({"id":digest([key,[e["id"] for e in window]])[:16],"correlationKey":key,"eventIds":[e["id"] for e in window],"state":"open"});break
    latest=max([e["time"] for e in history],default=0)
    retained=[e for e in history if e["time"]>=latest-a["windowSeconds"]]
    return {"passed":not incidents,"incidents":incidents,"incidentLedger":[*a.get("incidentLedger",[]),*incidents],"history":retained,"duplicates":duplicates,"seenIds":sorted(seen),"revision":a.get("revision",0)+1}


def negotiate(a):
    proposals=a["proposals"];capacity=num(a["capacity"])
    if capacity<0 or any(num(p["minimum"])<0 or num(p["requested"])<p["minimum"] for p in proposals): raise ValueError("요청·최소량을 확인해 주세요.")
    minimum=sum(p["minimum"] for p in proposals)
    if minimum>capacity:return {"passed":False,"status":"no_agreement","shortage":minimum-capacity,"allocation":[]}
    spare=capacity-minimum;extra=sum(p["requested"]-p["minimum"] for p in proposals)
    allocation=[{"id":p["id"],"amount":p["minimum"]+(min(spare,extra)*(p["requested"]-p["minimum"])/extra if extra else 0)} for p in proposals]
    return {"passed":True,"status":"counterproposal" if extra>spare else "accepted","allocation":allocation,"total":sum(v["amount"] for v in allocation)}


def document_impact(a):
    old,new=a["before"],a["after"]
    changed=sorted(k for k in set(old)|set(new) if old.get(k)!=new.get(k)); preserved=[];invalid=[]
    for review in a["reviews"]:
        (invalid if set(review["sections"])&set(changed) else preserved).append(review["role"])
    return {"passed":not invalid,"changedSections":changed,"invalidatedRoles":invalid,"preservedRoles":preserved,"newVersion":digest(new),"beforeVersion":digest(old)}


def audit(a):
    approvals={r["id"]:r for r in a["approvals"]};violations=[];insufficient=[]
    for i,call in enumerate(a["calls"]):
        if call["effect"]!="write": continue
        approval=approvals.get(call.get("approvalId"))
        expected=digest(call["arguments"])
        if not approval:insufficient.append({"callId":call["id"],"reason":"approval_missing"});continue
        if approval["status"]!="approved" or approval["tool"]!=call["tool"] or approval["argsHash"]!=expected or approval["at"]>call["at"] or approval["expiresAt"]<=call["at"] or approval["runId"]!=call["runId"]:violations.append({"callId":call["id"],"reason":"approval_binding_or_order"})
        if any(old["effect"]=="write" and old["tool"]==call["tool"] and old["arguments"]==call["arguments"] and old.get("outcome") in ("completed","unknown_outcome") for old in a["calls"][:i]):violations.append({"callId":call["id"],"reason":"unsafe_replay"})
    return {"passed":not violations and not insufficient,"violations":violations,"insufficient":insufficient,"checked":len(a["calls"])}


def revoke(a):
    revoked=set(a["revokedIds"])
    generations=[{**g,"documents":[d for d in g["documents"] if d["id"] not in revoked],"evaluationValid":False} for g in a["generations"]]
    edges=[e for e in a["edges"] if e["sourceId"] not in revoked and e["from"] not in revoked and e["to"] not in revoked]
    acknowledgements=set(a.get("acknowledgedSystems",[]));pending=sorted(set(a.get("requiredSystems",[]))-acknowledgements)
    return {"passed":not pending,"generations":generations,"edges":edges,"revokedIds":sorted(revoked),"pendingSystems":pending,"originalReportsRecalled":False,"revision":a.get("revision",0)+1}


def feedback(a):
    causes=[]
    for item in a["cases"]:
        cause="retrieval" if item["expectedSource"] not in item["retrievedIds"] else "source" if item["sourceVersion"]!=item["currentVersion"] else "generation" if item["quote"] not in item["sourceText"] else "unconfirmed"
        causes.append({"id":item["id"],"cause":cause})
    before=sum(x["beforePassed"] for x in a["evaluation"]);after=sum(x["afterPassed"] for x in a["evaluation"])
    regression=[x["id"] for x in a["evaluation"] if x["beforePassed"] and not x["afterPassed"]]
    return {"passed":after>before and not regression,"causes":causes,"beforeCorrect":before,"afterCorrect":after,"regressions":regression,"total":len(a["evaluation"])}


def asof(a):
    instant=datetime.fromisoformat(a["asOf"]);selected=[];denied=[]
    accessible=set(a["accessibleIds"]) if "accessibleIds" in a else None
    for doc in a["documents"]:
        start=datetime.fromisoformat(doc["validFrom"]);end=datetime.fromisoformat(doc["validTo"])
        if end<=start:raise ValueError("적용 기간의 시작과 끝을 확인해 주세요.")
        if start<=instant<end:
            permitted=doc["id"] in accessible if accessible is not None else doc["currentPermission"]
            (selected if permitted else denied).append(doc)
    groups={d["topic"] for d in selected};overlaps=[key for key in groups if sum(d["topic"]==key for d in selected)>1]
    missing=sorted(set(a["topics"])-groups)
    return {"passed":not overlaps and not missing,"selected":selected,"overlapTopics":overlaps,"missingTopics":missing,"deniedIds":[d["id"] for d in denied],"asOf":a["asOf"]}


def join_numeric(a):
    docs={(d["entityId"],d["period"]):d for d in a["documents"]};joined=[];errors=[]
    for row in a["rows"]:
        doc=docs.get((row["entityId"],row["period"]))
        if not doc or doc["unit"]!=row["unit"]:errors.append(row["entityId"]);continue
        joined.append({"entityId":row["entityId"],"value":num(row["value"]),"unit":row["unit"],"cell":row["cell"],"sourceId":doc["id"],"quote":doc["text"]})
    units={r["unit"] for r in joined}
    return {"passed":not errors and len(units)==1,"mismatchedIds":errors,"rows":joined,"sum":sum(r["value"] for r in joined) if len(units)==1 else None,"unit":next(iter(units)) if len(units)==1 else None}


# 입력의 관계를 탐색한다. 외부 지식 그래프 자동 구축이나 네트워크 자료 수집은 하지 않는다.
def graph_search(a):
    start=a["start"];allowed=set(a["allowedSourceIds"]);queue=[(start,0,[])];seen={start};paths=[];denied=0
    if not 1<=a["maxDepth"]<=8:raise ValueError("관계 깊이는 1~8이에요.")
    while queue:
        current,depth,lineage=queue.pop(0)
        if depth>=a["maxDepth"]:continue
        for edge in a["edges"]:
            if edge["from"]!=current:continue
            if edge["sourceId"] not in allowed or not edge.get("readable",True):denied+=1;continue
            if edge["to"] in seen:continue
            seen.add(edge["to"]);proof=lineage+[edge["id"]];paths.append({"node":edge["to"],"depth":depth+1,"edgeIds":proof,"sourceId":edge["sourceId"]});queue.append((edge["to"],depth+1,proof))
    return {"passed":bool(paths),"nodes":sorted(seen),"paths":paths,"deniedEdges":denied,"maxDepth":a["maxDepth"]}


def cells(a):
    selected=[c for c in a["cells"] if c["address"] in a["addresses"]];units={c["unit"] for c in selected};missing=sorted(set(a["addresses"])-{c["address"] for c in selected})
    passed=not missing and len(units)==1 and all(c["period"]==a["period"] for c in selected)
    values=[num(c["value"]) for c in selected]
    return {"passed":passed,"missingCells":missing,"result":sum(values) if passed else None,"unit":next(iter(units)) if len(units)==1 else None,"formula":"SUM("+",".join(a["addresses"])+")","citations":[{"address":c["address"],"sourceId":c["sourceId"],"value":c["value"]} for c in selected]}


def api_diff(a):
    before,after=a["before"],a["after"];removed=sorted(set(before)-set(after));changed=sorted(k for k in set(before)&set(after) if before[k]!=after[k]);affected=[]
    for consumer in a["consumers"]:
        if set(consumer["fields"])&set(removed+changed):affected.append(consumer["id"])
    return {"passed":not removed and not changed,"removed":removed,"changed":changed,"added":sorted(set(after)-set(before)),"affectedConsumers":affected,"requiredTests":sorted(set(affected))}


def migration(a):
    rows=a["rows"];mapping=a["rename"];after=[];errors=[];ids=set()
    for row in rows:
        transformed={mapping.get(key,key):value for key,value in row.items()}
        if len(transformed)!=len(row):raise ValueError("두 필드를 같은 이름으로 덮어쓸 수 없어요.")
        identity=transformed.get(a["idField"])
        if identity in ids or identity is None:errors.append("duplicate_or_missing_id")
        ids.add(identity);after.append(transformed)
    for row in after:
        for field,kind in a.get("fieldTypes",{}).items():
            value=row.get(field)
            valid=isinstance(value,str) if kind=="string" else type(value) in (int,float) if kind=="number" else isinstance(value,bool) if kind=="boolean" else False
            if not valid:errors.append("field_type:"+field+":"+str(row.get(a["idField"])))
        for ref in a.get("references",[]):
            if row.get(ref["field"]) not in ref["allowedIds"]:errors.append("broken_reference:"+str(row.get(a["idField"])))
    return {"passed":not errors,"beforeCount":len(rows),"afterCount":len(after),"rows":after,"errors":errors,"beforeHash":digest(rows),"afterHash":digest(after),"databaseModified":False}


def version_tuple(value):
    if not re.fullmatch(r"\d+\.\d+\.\d+",value):raise ValueError("버전은 major.minor.patch 숫자 형식이어야 해요.")
    return tuple(int(x) for x in value.split("."))


def compatibility(a):
    versions={k:version_tuple(v) for k,v in a["versions"].items()};conflicts=[];unknown=[]
    for rule in a["requirements"]:
        value=versions.get(rule["dependency"])
        if value is None:unknown.append(rule);continue
        if not version_tuple(rule["minimum"])<=value<version_tuple(rule["maximumExclusive"]):conflicts.append({"path":[rule["component"],rule["dependency"]],"installed":a["versions"][rule["dependency"]],"minimum":rule["minimum"],"maximumExclusive":rule["maximumExclusive"]})
    return {"passed":not conflicts and not unknown,"conflicts":conflicts,"unknown":unknown}


def procedure(a):
    completed=set(a.get("initialConditions",[]));violations=[]
    for step in a["steps"]:
        missing=sorted(set(step["requires"])-completed)
        if missing:violations.append({"step":step["id"],"reason":"missing_preconditions","missing":missing})
        if step.get("effect")=="write" and (not step.get("approval") or not step.get("rollback")):violations.append({"step":step["id"],"reason":"approval_or_rollback_missing"})
        completed.update(step.get("provides",[]))
    return {"passed":not violations,"violations":violations,"finalConditions":sorted(completed),"steps":len(a["steps"])}


def config_diff(a):
    secrets=re.compile(r"secret|password|token|api.?key",re.I)
    actual={k:("[REDACTED]" if secrets.search(k) else v.strip() if isinstance(v,str) else v) for k,v in a["actual"].items()}
    standard={k:("[REDACTED]" if secrets.search(k) else v.strip() if isinstance(v,str) else v) for k,v in a["standard"].items()}
    differences=[{"field":k,"actual":actual.get(k),"expected":v} for k,v in standard.items() if not secrets.search(k) and actual.get(k)!=v]
    return {"passed":not differences,"differences":differences,"redactedFields":[k for k in actual if secrets.search(k)],"actual":actual}


def alignment(a):
    if "codeSource" in a:
        source=a["codeSource"]
        if not isinstance(source,str) or len(source)>100000:raise ValueError("코드 분석은 100,000자 이하여야 해요.")
        tree=ast.parse(source);symbols={};routes={}
        for node in tree.body:
            if not isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)):continue
            if node.name in symbols:raise ValueError("같은 함수 이름이 중복되어 대응을 확정할 수 없어요.")
            symbols[node.name]={"name":node.name,"parameters":[arg.arg for arg in [*node.args.posonlyargs,*node.args.args,*node.args.kwonlyargs]],"location":str(a.get("sourceName","supplied.py"))[:80]+":"+str(node.lineno)}
            for decorator in node.decorator_list:
                if isinstance(decorator,ast.Call) and isinstance(decorator.func,ast.Attribute) and decorator.func.attr in ("get","post","put","patch","delete","head","options") and decorator.args and isinstance(decorator.args[0],ast.Constant) and isinstance(decorator.args[0].value,str):
                    routes[node.name]={"symbol":node.name,"method":decorator.func.attr.upper(),"path":decorator.args[0].value}
    else:
        symbols={v["name"]:v for v in a["symbols"]};routes={v["symbol"]:v for v in a["routes"]}
    checks=[]
    for doc in a["documents"]:
        symbol=symbols.get(doc["symbol"]);route=routes.get(doc["symbol"])
        matched=bool(symbol and route and symbol["parameters"]==doc["parameters"] and route["method"]==doc["method"] and route["path"]==doc["path"])
        checks.append({"documentId":doc["id"],"symbol":doc["symbol"],"passed":matched,"codeLocation":symbol.get("location") if symbol else None,"apiPath":route.get("path") if route else None})
    return {"passed":bool(checks) and all(x["passed"] for x in checks),"checks":checks,"requiredExampleIds":[d["exampleId"] for d in a["documents"]],"extraction":"python_ast" if "codeSource" in a else "supplied_contract_snapshot"}


# 표시용 구조/SVG 지시를 만든다. 실제 음성/영상 제공자 호출은 수행하지 않는다.
def avatar(a):
    # A portable visual avatar cue contract, deliberately separate from TTS/media generation.
    correct=sum(x["answer"]==x["expected"] for x in a.get("checks",[]));total=len(a.get("checks",[]));passed=total>0 and correct==total
    action=a.get("choice","continue");state=a.get("state","intro")
    transitions={"intro":{"ask":"clarify","continue":"practice"},"clarify":{"confirm":"practice","refuse":"hold"},"practice":{"finish":"review","retry":"practice"},"review":{"finish":"complete"}}
    next_state=transitions.get(state,{}).get(action,"hold")
    caption=str(a.get("caption","다음 확인 항목을 안내합니다."))[:160]
    mouth='M70 90 Q100 115 130 90' if passed else 'M75 102 Q100 87 125 102'
    svg=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" role="img"><title>{html.escape(caption)}</title><rect width="400" height="200" fill="#eef4ff"/><circle cx="100" cy="85" r="58" fill="#b7cdfb"/><circle cx="80" cy="73" r="5"/><circle cx="120" cy="73" r="5"/><path d="{mouth}" fill="none" stroke="#172448" stroke-width="4"/><text x="180" y="85" fill="#172448" font-size="14">{html.escape("확인 완료" if passed else "다시 살펴보기")}</text><text x="20" y="175" fill="#172448" font-size="11">{html.escape(caption[:32])}</text></svg>'
    return {"passed":passed,"correct":correct,"total":total,"level":"advance" if passed else "reinforce","state":next_state,"revision":a.get("revision",0)+1,"avatar":{"format":"flowly-avatar-cue-v1","expression":"encouraging" if passed else "thoughtful","gesture":"acknowledge" if passed else "explain","caption":caption,"speechText":caption,"svg":svg}}


def correlate(a):
    event,case=a["event"],a["case"]
    matched=event["correlationId"]==case["id"]
    expired=num(event["receivedAt"])>num(case["deadline"])
    return {"passed":matched and not expired,"reason":"correlation_mismatch" if not matched else "deadline_expired" if expired else "response_matched","caseId":case["id"],"state":"closed" if matched and not expired else "reminder_due","revision":case["revision"]+1,"response":event["response"] if matched else None}


def citation(a):
    answer=a["answer"];source=next((d for d in a["documents"] if d["id"]==answer["sourceId"]),None)
    return {"passed":bool(source and answer["quote"] and answer["quote"] in source["text"]),"answer":answer,"sourceId":answer["sourceId"]}


def partition(a):
    fields=set(a["allowedFields"]);result={key:value for key,value in a["record"].items() if key in fields}
    return {"passed":True,"record":result,"removedFields":sorted(set(a["record"])-fields)}


def improvement(a):
    if "beforeChecks" in a:
        def checks(name):
            result={}
            for item in a[name]:
                key=(item["query"],item["resourceId"])
                if key in result or not isinstance(item["passed"],bool):raise ValueError("회귀 평가 질문과 결과를 확인해 주세요.")
                result[key]=item["passed"]
            if not 2<=len(result)<=10:raise ValueError("동일 회귀 질문 2~10개가 필요해요.")
            return result
        before,after=checks("beforeChecks"),checks("afterChecks")
        if set(before)!=set(after):raise ValueError("기준 세대와 후보 세대의 회귀 질문이 달라요.")
        improved=[query for query in before if not before[query] and after[query]]
        regressed=[query for query in before if before[query] and not after[query]]
        return {"passed":bool(improved) and not regressed and all(after.values()),"improvedQueries":[q[0] for q in improved],"regressedQueries":[q[0] for q in regressed],"evaluatedCount":len(before),"baselineChecks":a["beforeChecks"],"candidateChecks":a["afterChecks"],"candidateGeneration":a["candidateGeneration"],"baselineGeneration":a["baselineGeneration"]}
    return {"passed":not a["beforePassed"] and a["afterPassed"],"beforePassed":a["beforePassed"],"afterPassed":a["afterPassed"],"candidateGeneration":a["candidateGeneration"],"baselineGeneration":a["baselineGeneration"]}


def documents(a):
    if a["resourceId"]!="feedback-policy" or not isinstance(a["content"],str):raise ValueError("허용된 수정자료와본문을 확인해 주세요.")
    return {"documents":[{"resourceId":a["resourceId"],"version":a["version"],"content":a["content"]}]}


def board_transition(a):
    board=copy.deepcopy(a["board"]);expected=a["expectedRevision"];task=board["tasks"].get(a["taskId"]);now=num(a["now"])
    if expected!=board["revision"]:return {"passed":False,"reason":"stale_revision","board":board,"expectedRevision":expected}
    if not task:raise ValueError("등록된 작업이 아니에요.")
    if a["action"] in ("claim","reclaim"):
        ready=all(board["tasks"][d]["status"]=="completed" for d in task.get("dependsOn",[]))
        if a["action"]=="reclaim" and (task["status"]!="claimed" or task["leaseUntil"]>now):return {"passed":False,"reason":"lease_not_expired","board":board,"expectedRevision":expected}
        if not ready or task["status"]=="completed" or task["status"]=="claimed" and task["leaseUntil"]>now:return {"passed":False,"reason":"not_ready_or_claimed","board":board,"expectedRevision":expected}
        task.update({"status":"claimed","owner":a["actor"],"leaseUntil":now+min(300,max(1,num(a.get("leaseSeconds",60)))),"claimRevision":expected+1,"attempt":task.get("attempt",0)+1})
    elif a["action"] in ("publish","renew"):
        # Earlier exported graphs omitted the token. Their revision CAS remains
        # mandatory; new graphs additionally bind this explicit claim token.
        if task["status"]!="claimed" or task["owner"]!=a["actor"] or task["leaseUntil"]<=now or a.get("claimRevision",task["claimRevision"])!=task["claimRevision"]:return {"passed":False,"reason":"claim_owner_lease_or_token","board":board,"expectedRevision":expected}
        if a["action"]=="renew":
            task["leaseUntil"]=max(task["leaseUntil"],now+min(300,max(1,num(a.get("leaseSeconds",60)))))
            task["renewals"]=task.get("renewals",0)+1
        else:
            artifact=a["artifact"]
            task.update({"status":"completed","artifact":artifact,"artifactHash":digest(artifact)})
    else:raise ValueError("작업판 action은 claim/reclaim/renew/publish예요.")
    board["revision"]+=1
    ready=sorted(k for k,v in board["tasks"].items() if v["status"]=="pending" and all(board["tasks"][d]["status"]=="completed" for d in v.get("dependsOn",[])))
    return {"passed":True,"board":board,"request":a.get("request",{}),"expectedRevision":expected,"readyTaskIds":ready,"revision":board["revision"]}


def board_request(a):
    board=a["board"];step=a["step"];request=a["request"]
    actions={"renew_analysis":("renew","analysis"),"publish_analysis":("publish","analysis"),"claim_implementation":("claim","implementation"),"publish_implementation":("publish","implementation")}
    if step not in actions:raise ValueError("등록된 작업판 단계가 아니에요.")
    action,task_id=actions[step];task=board["tasks"][task_id]
    actor="implementer" if task_id=="implementation" else request["actor"]
    result={"board":board,"request":request,"expectedRevision":board["revision"],"action":action,"taskId":task_id,"actor":actor,"leaseSeconds":request.get("leaseSeconds",60)}
    if action in ("renew","publish"):result["claimRevision"]=task["claimRevision"]
    if action=="publish":result["artifact"]=a["artifact"]
    return result


def case_event(a):
    ledger=copy.deepcopy(a["ledger"]);event=a["event"];rid=event["caseId"];eid=event["eventId"];kind=event["kind"]
    if not all(isinstance(value,str) and 0<len(value)<=100 for value in (rid,eid)):raise ValueError("사건과 이벤트 식별자를 확인해 주세요.")
    if kind not in ("open","response","deadline"):raise ValueError("등록된 사건 이벤트가 아니에요.")
    cases=ledger["cases"];seen=ledger["events"];signature=digest(event);expected=ledger["revision"]
    if eid in seen:
        if seen[eid]!=signature:raise ValueError("같은 이벤트 ID의 내용이 달라요.")
        return {"changed":False,"action":"duplicate","ledger":ledger,"expectedRevision":expected,"case":cases.get(rid),"eventId":eid}
    if len(seen)>=1000 or len(cases)>=100 and rid not in cases:raise ValueError("사건 원장의 보존 한도를 확인해 주세요.")
    at=num(event["at"]);case=cases.get(rid)
    if kind=="open":
        if case:raise ValueError("이미 존재하는 사건을 다시 열 수 없어요.")
        deadline=num(event["deadline"])
        if deadline<=at:raise ValueError("사건 기한은 시작 이후여야 해요.")
        case={"id":rid,"status":"waiting","openedAt":at,"deadline":deadline,"response":None,"reminderEventId":None};cases[rid]=case;action="waiting"
    else:
        if not case:raise ValueError("먼저 등록한 사건의 이벤트만 처리해요.")
        if at<case["openedAt"]:raise ValueError("사건 시작 이전 이벤트예요.")
        if kind=="response":
            response=event["response"]
            if not isinstance(response,str) or not response.strip() or len(response)>10000:raise ValueError("사건 응답 본문을 확인해 주세요.")
            if case["status"]=="closed":action="already_closed"
            elif at>case["deadline"]:case["lateResponse"]={"at":at,"text":response};action="late_response"
            else:case.update(status="closed",response=response,closedAt=at);action="closed"
        else:
            if at<case["deadline"]:action="not_due"
            elif case["status"]=="closed":action="already_closed"
            elif case["reminderEventId"]:action="reminder_reserved"
            else:case.update(status="reminder_pending",reminderEventId=eid);action="remind"
    seen[eid]=signature;ledger["revision"]+=1
    return {"changed":True,"action":action,"ledger":ledger,"expectedRevision":expected,"case":case,"eventId":eid}


def case_delivery(a):
    transition=a["transition"];receipt=a["receipt"];ledger=copy.deepcopy(transition["ledger"])
    case=ledger["cases"][transition["case"]["id"]];expected=ledger["revision"]
    if receipt.get("caseId")!=case["id"] or receipt.get("eventId")!=transition["eventId"] or not isinstance(receipt.get("receiptId"),str) or not receipt["receiptId"]:
        raise ValueError("사내 서비스 영수증의 사건·이벤트 ID가 달라요.")
    if transition["action"]=="waiting":
        if receipt.get("scheduled") is not True or receipt.get("deadline")!=case["deadline"]:raise ValueError("기한 이벤트 예약을 확인하지 못했어요.")
        case["scheduleReceiptId"]=receipt["receiptId"]
    elif transition["action"]=="remind":
        if receipt.get("sent") is not True:raise ValueError("재촉 발송을 확인하지 못했어요.")
        case.update(status="reminded",reminderReceiptId=receipt["receiptId"])
    else:raise ValueError("영수증을 연결할 사건 작업이 아니에요.")
    ledger["revision"]+=1
    return {"ledger":ledger,"expectedRevision":expected,"case":case,"receipt":receipt}


def goal_update(a):
    baseline=a["baseline"]; threshold=num(a["threshold"])
    if not -1000<=threshold<=1000:raise ValueError("목표 한도를 확인해 주세요.")
    old=baseline["goal"]
    return {**baseline,"accepted":True,"previousGoal":old,"goal":{"version":old["version"]+1,"threshold":threshold},"previousValues":baseline["values"],"priorArtifacts":baseline["stepArtifacts"]}


def learning(a):
    learner=a["learner"]
    result=avatar({"checks":[{"answer":str(a["answer"]).strip().casefold(),"expected":str(a["expected"]).strip().casefold()}],"state":"practice","choice":"finish","revision":learner.get("revision",0),"caption":"이해한 내용을 확인하고 다음 학습을 안내합니다."})
    result["learner"]={"revision":result["revision"],"level":learner.get("level",1)+(1 if result["passed"] else 0),"attempts":learner.get("attempts",0)+1,"nextLesson":"application" if result["passed"] else "foundation","lastAnswer":str(a["answer"])[:200]}
    return result


def roleplay(a):
    state=a["session"];choice=a["choice"]
    options={"intro":{"ask":"clarify","continue":"practice"},"clarify":{"confirm":"practice","refuse":"hold"},"practice":{"finish":"review","retry":"practice"},"review":{"finish":"complete"}}
    valid=choice in options.get(state["state"],{})
    result=avatar({"state":state["state"],"choice":choice,"revision":state.get("revision",0),"checks":[{"answer":valid,"expected":True}],"caption":"상황의 선택과 역할 상태를 확인합니다."})
    result["session"]={"revision":result["revision"],"state":result["state"],"history":[*state.get("history",[]),{"from":state["state"],"choice":choice,"to":result["state"]}]}
    result["nextPractice"]="confirm requirements" if result["state"]=="clarify" else "demonstrate response" if result["state"]=="practice" else "review evidence"
    return result


def practice_avatar(a):
    record=a["record"];evidence=record["testEvidence"]
    if evidence["candidateHash"]!=record["candidateHash"]:raise ValueError("시험 대상 코드 해시가 달라요.")
    checks=[{"answer":case["actual"],"expected":case["expected"]} for case in evidence["cases"]]
    result=avatar({"state":"practice","choice":"finish","checks":checks,"caption":"실제로 실행한 코드 시험 결과를 확인합니다."})
    return {**result,"candidateHash":record["candidateHash"],"testEvidence":evidence,"candidateFiles":record["candidateFiles"]}


def experiment(a):
    mode=a["candidate"]
    if mode not in ("linear","quadratic"):raise ValueError("허용된 실험 후보가 아니에요.")
    if not a["rows"]:raise ValueError("평가 행이 필요해요.")
    predictions=[{"id":r["id"],"prediction":num(r["x"])**(2 if mode=="quadratic" else 1),"actual":num(r["y"])} for r in a["rows"]]
    mse=sum((p["prediction"]-p["actual"])**2 for p in predictions)/len(predictions)
    return {"passed":mse<=num(a["maxMse"]),"candidate":mode,"mse":mse,"predictions":predictions,"evaluationSet":a["evaluationSet"]}


def experiment_discovery(a):
    return experiment({"candidate":"linear","rows":a["discovery"],"maxMse":0,"evaluationSet":"discovery"})


def experiment_confirm(a):
    return experiment({"candidate":"quadratic","rows":a["heldout"],"maxMse":0,"evaluationSet":"heldout"})


OPERATIONS={"technical."+name:fn for name,fn in {
    "constraints":constraints,"sensitivity":sensitivity,"coverage":coverage,"cross_modal":cross_modal,
    "events":events,"negotiate":negotiate,"document_impact":document_impact,"audit":audit,
    "revoke":revoke,"feedback":feedback,"asof":asof,"join_numeric":join_numeric,"graph":graph_search,
    "cells":cells,"api_diff":api_diff,"migration":migration,"compatibility":compatibility,
    "procedure":procedure,"config_diff":config_diff,"alignment":alignment,"avatar":avatar,"correlate":correlate,"case_event":case_event,"case_delivery":case_delivery,"experiment":experiment,"experiment_discovery":experiment_discovery,"experiment_confirm":experiment_confirm,"citation":citation,"partition":partition,"improvement":improvement,"documents":documents,"taskboard_transition":board_transition,"taskboard_request":board_request,"goal_update":goal_update,"learning":learning,"roleplay":roleplay,"practice_avatar":practice_avatar,
}.items()}
CONTRACTS={name:{"description":fn.__name__+": bounded deterministic technical validation; no external I/O", "exampleArguments":{}, "effect":"read"} for name,fn in OPERATIONS.items()}


# 등록 프로그램에 제한 JSON만 분배한다. 코드처럼 보이는 입력 문자열도 임의 실행하지 않는다.
def execute(name,args):
    if name not in OPERATIONS:raise ValueError("등록되지 않은 기술 검증 프로그램이에요.")
    if not isinstance(args,dict):raise ValueError("프로그램 입력은 객체여야 해요.")
    bounded(args)
    try: return bounded(OPERATIONS[name](copy.deepcopy(args)))
    except (KeyError,TypeError,IndexError,AttributeError) as error: raise ValueError("기술 검증 입력 계약을 확인해 주세요.") from error
