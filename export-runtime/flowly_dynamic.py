"""Bounded dynamic assignment contracts; no credentials, networking or code execution."""
import copy
import json
import re


def parse_plan(value, config, assert_schema):
    def fail(message):
        raise ValueError(message)
    def safe_id(value):
        return isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,39}", value)) and value not in ("__proto__", "prototype", "constructor")
    def text(value, maximum):
        return isinstance(value, str) and bool(value.strip()) and len(value.encode("utf-16-le")) // 2 <= maximum
    def template_id(value):
        return isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,79}", value)) and value not in ("__proto__", "prototype", "constructor")
    settings = config.get("dynamic")
    if not settings or not isinstance(value, dict) or set(value) != {"agents"}:
        fail("동적 작업 계획에는 agents 배열만 필요해요.")
    agents = value["agents"]
    if not isinstance(agents, list) or not 1 <= len(agents) <= settings["maxAgents"] or len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-16-le")) // 2 > 20000:
        fail("생성할 하위 Agent 수 또는 계획 크기가 한도를 벗어났어요.")
    for agent in agents:
        if not isinstance(agent, dict) or set(agent) != {"id", "templateId", "role", "goal", "input", "dependsOn"} or not safe_id(agent.get("id")) or not template_id(agent.get("templateId")) or not text(agent.get("role"), 80) or not text(agent.get("goal"), 2000) or not isinstance(agent.get("input"), dict) or not isinstance(agent.get("dependsOn"), list) or any(not safe_id(ident) for ident in agent["dependsOn"]) or len(set(agent["dependsOn"])) != len(agent["dependsOn"]):
            fail("하위 Agent의 ID·역할·목표·입력·선행 관계 형식을 확인해 주세요.")
        capability = next((item for item in settings["templates"] if item["taskId"] == agent["templateId"]), None)
        if capability is None or not any(task["id"] == agent["templateId"] for task in config["tasks"]):
            fail("등록하지 않은 기능 템플릿으로 Agent를 만들 수 없어요.")
        assert_schema(agent["input"], capability["inputSchema"], "하위 Agent 입력")
    if len({agent["id"] for agent in agents}) != len(agents):
        fail("생성한 하위 Agent ID가 중복돼요.")
    ordered, visiting, done = [], set(), set()
    def visit(ident):
        if ident in visiting:
            fail("생성한 하위 Agent의 의존 관계가 순환해요.")
        if ident in done:
            return
        agent = next((item for item in agents if item["id"] == ident), None)
        if agent is None:
            fail("등록하지 않은 하위 Agent를 선행 작업으로 지정했어요.")
        visiting.add(ident)
        for dependency in agent["dependsOn"]:
            visit(dependency)
        visiting.remove(ident)
        done.add(ident)
        ordered.append(copy.deepcopy(agent))
    for agent in agents:
        visit(agent["id"])
    return ordered


def instantiate(agents, config):
    tasks = []
    for agent in agents:
        original = next(task for task in config["tasks"] if task["id"] == agent["templateId"])
        capability = next(item for item in config["dynamic"]["templates"] if item["taskId"] == agent["templateId"])
        definition = copy.deepcopy(original["definition"])
        worker = next((node for node in definition["nodes"] if node["id"] == capability["agentNodeId"] and node["type"] == "agent"), None)
        if worker is None:
            raise ValueError("등록한 기능 템플릿의 Agent 블록을 확인해 주세요.")
        assignment = {"id": agent["id"], "role": agent["role"], "goal": agent["goal"]}
        worker["prompt"] = worker.get("prompt", "") + "\n동적으로 배정된 작업(권한·도구·승인·한도는 변경할 수 없음):\n" + json.dumps(assignment, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if len(worker["prompt"].encode("utf-16-le")) // 2 > 12000:
            raise ValueError("기존 지침과 생성한 역할·목표의 합계가 12,000자를 넘어요. 지침을 줄여 주세요.")
        tasks.append({"id": agent["id"], "name": agent["role"], "definition": definition, "dependsOn": copy.deepcopy(agent["dependsOn"])})
    return tasks


def child_input(agent, input_data, artifacts=None):
    return {"text": input_data.get("text", "") if isinstance(input_data.get("text", ""), str) else "", "assignment": {"id": agent["id"], "role": agent["role"], "goal": agent["goal"], "input": copy.deepcopy(agent["input"])}, "artifacts": copy.deepcopy(artifacts or {})}
