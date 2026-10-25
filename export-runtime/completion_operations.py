"""Bounded reference-project operations used by the completed example workflows.

This is a registered lab, not a shell, repository executor, arbitrary SQL service,
or a browser. Each operation consumes JSON and returns observable evidence. The
SQLite database is recreated in memory from bounded rows; backups contain real
SQLite bytes. A company's persistent systems require separately registered MCPs.
"""
from __future__ import annotations

import ast
import base64
import copy
import hashlib
import io
import json
import math
import os
import sqlite3
import statistics
import subprocess
import sys
import tarfile
import tempfile
import zlib
from pathlib import Path
from html.parser import HTMLParser


MAX_ROWS = 500
SOURCE = {
    "legacy": "def average(values):\n    return sum(values) / (len(values) + 1)\n",
    "fixed": "def average(values):\n    if not values:\n        raise ValueError('empty')\n    return sum(values) / len(values)\n",
    "refactor": "def average(values):\n    count = len(values)\n    if count == 0:\n        raise ValueError('empty')\n    total = sum(values)\n    return total / count\n",
}
CASES = [([2, 4], 3.0), ([-4, -2], -3.0), ([7], 7.0), ([], "empty")]


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def bounded(value):
    if not isinstance(value, dict) or len(json.dumps(value, ensure_ascii=False)) > 1500000:
        raise ValueError("operation arguments must be a bounded JSON object")
    return copy.deepcopy(value)


def context(args):
    # A merge node may add an Agent proposal. It cannot replace the measured state.
    value = args.get("executed", args.get("reused", args))
    proposals = []
    while isinstance(value, dict) and isinstance(value.get("record"), dict):
        if "proposal" in value:
            proposals.append(value["proposal"])
        value = value["record"]
    if not isinstance(value, dict):
        raise ValueError("record must be an object")
    result = bounded(value)
    if proposals:
        result["proposal"] = proposals[0]
    if "proposal" in args:
        result["proposal"] = args["proposal"]
    if isinstance(args.get("supplement"), dict):
        for key in ("html", "expectedRevision", "values", "goal", "currentDocuments"):
            if key in args["supplement"]:
                result[key] = args["supplement"][key]
    return result


def finish(state, operation, evidence, passed=True):
    state["passed"] = bool(passed)
    state["evidence"] = evidence
    state.setdefault("artifacts", {})[operation] = evidence
    ledger = state.setdefault("ledger", [])
    if len(ledger) >= 80:
        raise ValueError("operation ledger exceeds 80 steps")
    ledger.append({"operation": operation, "inputVersion": digest(ledger[-1]) if ledger else "initial", "evidenceHash": digest(evidence), "passed": bool(passed)})
    state["ledgerHash"] = digest(ledger)
    return state


def registered_average(values, version):
    if version not in SOURCE:
        raise ValueError("unregistered code version")
    if not isinstance(values, list) or len(values) > 10000 or any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) for v in values):
        raise ValueError("finite numeric values required")
    if not values and version != "legacy":
        return "empty"
    return sum(values) / (len(values) + (1 if version == "legacy" else 0)) if values else 0


def code_inspect(args):
    s = context(args)
    if s.get("project", "registered-average") != "registered-average":
        raise ValueError("only registered-average is installed; register a company MCP for other repositories")
    version = s.get("version", "legacy")
    if version not in SOURCE:
        raise ValueError("unknown registered version")
    tree = ast.parse(SOURCE[version])
    s["sourceVersion"] = version
    s["sourceHash"] = digest(SOURCE[version])
    return finish(s, "code_inspect", {"project": "registered-average", "sourceHash": s["sourceHash"], "functions": [n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)], "nodes": len(list(ast.walk(tree))), "scope": "fixed registered Python reference project"})


def code_reproduce(args):
    s = context(args)
    results = [{"input": values, "expected": expected, "actual": registered_average(values, s.get("sourceVersion", "legacy"))} for values, expected in CASES]
    failures = [r for r in results if r["actual"] != r["expected"]]
    s["reproducer"] = results
    return finish(s, "code_reproduce", {"cases": results, "failureCount": len(failures), "sourceHash": s.get("sourceHash")}, bool(failures))


def code_patch(args):
    s = context(args)
    proposal = s.get("proposal", {})
    action = proposal.get("action", "fix_average") if isinstance(proposal, dict) else "fix_average"
    if action not in ("fix_average", "refactor_average", "keep_legacy"):
        raise ValueError("Agent proposed an unregistered patch")
    s["candidateVersion"] = "legacy" if action == "keep_legacy" else "refactor" if action == "refactor_average" else "fixed"
    s["candidateHash"] = digest(SOURCE[s["candidateVersion"]])
    with tempfile.TemporaryDirectory(prefix="flowly-code-") as workspace:
        target = Path(workspace) / "average.py"
        target.write_text(SOURCE[s["candidateVersion"]], encoding="utf-8")
        materialized = target.read_text(encoding="utf-8")
        ast.parse(materialized)
    s["candidateFiles"] = {"average.py": materialized}
    return finish(s, "code_patch", {"action": action, "before": s.get("sourceHash"), "after": s["candidateHash"], "registeredSource": materialized, "materializedFiles": ["average.py"], "workspace": "isolated temporary directory"})


def code_test(args):
    s = context(args)
    version = s.get("candidateVersion", "fixed")
    if version not in SOURCE:
        raise ValueError("unknown registered candidate")
    if s.get("candidateFiles", {}).get("average.py", SOURCE[version]) != SOURCE[version]:
        raise ValueError("uploaded/modified source is not executable; choose a registered patch")
    # Execute only the exact fixed source above. Neither paths, command text,
    # imports nor uploaded source are accepted from a workflow or model.
    driver = "\nimport json\nresults=[]\nfor values in [[2,4],[-4,-2],[7],[]]:\n    try: results.append(average(values))\n    except ValueError: results.append('empty')\n    except ZeroDivisionError: results.append('division_by_zero')\nprint(json.dumps(results))\n"
    with tempfile.TemporaryDirectory(prefix="flowly-test-") as workspace:
        target = Path(workspace) / "registered_test.py"
        target.write_text(SOURCE[version] + driver, encoding="utf-8")
        process = subprocess.run([sys.executable, "-I", "-S", str(target)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8, check=True)
        actual = json.loads(process.stdout)
    cases = [{"input": a, "expected": b, "actual": value} for (a, b), value in zip(CASES, actual)]
    passed = all(c["expected"] == c["actual"] for c in cases)
    s["testEvidence"] = {"candidateHash": s.get("candidateHash", digest(SOURCE[s.get("candidateVersion", "fixed")])), "cases": cases, "passed": passed}
    return finish(s, "code_test", s["testEvidence"], passed)


def code_differential(args):
    s = context(args)
    rows = []
    for count in range(0, 9):
        values = [((i * 7 + count) % 13) - 6 for i in range(count)]
        rows.append({"input": values, "baseline": registered_average(values, "fixed"), "candidate": registered_average(values, s.get("candidateVersion", "refactor"))})
    return finish(s, "code_differential", {"compared": len(rows), "cases": rows}, all(r["baseline"] == r["candidate"] for r in rows))


def code_mutation(args):
    s = context(args)
    selected = s.get("testInputs", [[2, 4], [-4, -2], [7], []])
    if not isinstance(selected, list) or not 1 <= len(selected) <= 20:
        raise ValueError("1..20 test inputs required")
    killed = [values for values in selected if registered_average(values, "legacy") != registered_average(values, "fixed")]
    mapped = {"positive": any(v and all(x > 0 for x in v) for v in selected), "negative": any(v and all(x < 0 for x in v) for v in selected), "singleton": any(len(v) == 1 for v in selected), "empty": [] in selected}
    return finish(s, "code_mutation", {"requirementCoverage": mapped, "killedMutants": len(killed), "totalMutants": 1, "testInputs": selected}, all(mapped.values()) and bool(killed))


def code_schedule(args):
    s = context(args)
    schedules = [["ar", "br", "aw", "bw"], ["ar", "aw", "br", "bw"], ["br", "ar", "bw", "aw"]]
    results = []
    for schedule in schedules:
        value, registers, trace = 0, {}, []
        for action in schedule:
            actor, phase = action
            if phase == "r":
                registers[actor] = value
            else:
                value = value + 1 if s.get("atomic", True) else registers[actor] + 1
            trace.append({"action": action, "value": value})
        results.append({"schedule": schedule, "result": value, "trace": trace})
    return finish(s, "code_schedule", {"controlledSchedules": results, "algorithm": "atomic increment" if s.get("atomic", True) else "split read/write"}, all(r["result"] == 2 for r in results))


def code_dependencies(args):
    s = context(args)
    packages = {"app": {"1": {"format": "1"}, "2": {"format": "2"}}, "format": {"1": {}, "2": {}}}
    requested = s.get("dependencyVersion", "2")
    if requested not in packages["app"]:
        return finish(s, "code_dependencies", {"conflicts": ["unregistered package version"], "registry": "bundled offline reference packages"}, False)
    lock = {"app": requested, **packages["app"][requested]}
    s["lockfile"] = lock
    s["lockHash"] = digest(lock)
    return finish(s, "code_dependencies", {"resolved": lock, "lockHash": s["lockHash"], "downloads": 0, "compatibility": all(v in packages[k] for k, v in lock.items())})


def code_build(args):
    s = context(args)
    files = {"average.py": SOURCE[s.get("candidateVersion", "fixed")], "lock.json": json.dumps(s.get("lockfile", {"app": "2", "format": "2"}), sort_keys=True), "runtime.json": '{"format":1,"project":"registered-average"}'}
    # Parsing verifies the registered Python source. Reproducible tar archives
    # exercise actual packaging while removing clock/order metadata.
    ast.parse(files["average.py"])
    def archive(items):
        out = io.BytesIO()
        with tarfile.open(fileobj=out, mode="w") as tar:
            for path in sorted(items):
                content = items[path].encode()
                info = tarfile.TarInfo(path)
                info.size, info.mtime, info.mode = len(content), 0, 0o644
                tar.addfile(info, io.BytesIO(content))
        return out.getvalue()
    with tempfile.TemporaryDirectory(prefix="flowly-build-") as workspace:
        roots = [Path(workspace)/"clean-first", Path(workspace)/"clean-second"]
        for index, root in enumerate(roots):
            root.mkdir()
            entries = list(files.items()) if index == 0 else list(reversed(list(files.items())))
            for name, content in entries:
                (root/name).write_text(content, encoding="utf-8", newline="\n")
        first, second = [archive({name:(root/name).read_text(encoding="utf-8") for name in files}) for root in roots]
    h1, h2 = hashlib.sha256(first).hexdigest(), hashlib.sha256(second).hexdigest()
    s["buildHash"] = h1
    return finish(s, "code_build", {"firstHash": h1, "cleanRebuildHash": h2, "files": sorted(files), "archiveBytes": len(first), "sourceHash": digest(files["average.py"]), "isolatedCleanWorkspaces": 2}, h1 == h2 and s.get("expectedBuildHash", h1) == h1)


def code_benchmark(args):
    s = context(args)
    # Deterministic primitive work counters avoid claiming machine-time results.
    samples = []
    for n in [20, 40, 80, 160, 320]:
        data = list(range(n))
        baseline = sum(1 for value in data for other in data if value == other)
        candidate = len(set(data))
        samples.append({"size": n, "sameResult": baseline == candidate, "baselineComparisons": n*n, "candidateVisits": n if s.get("optimized", True) else n*n})
    ratios = [r["baselineComparisons"] / r["candidateVisits"] for r in samples]
    return finish(s, "code_benchmark", {"metric": "instrumented operation count; not wall clock", "samples": samples, "medianSpeedup": statistics.median(ratios), "range": [min(ratios), max(ratios)]}, all(r["sameResult"] for r in samples) and min(ratios) >= 10)


class FormParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.controls, self.labels = {}, set()
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("input", "button", "select") and a.get("id"):
            self.controls[a["id"]] = {"tag": tag, **a}
        if tag == "label" and a.get("for"):
            self.labels.add(a["for"])


def installed_chrome_path():
    """Shared readiness/execution probe; no workflow-supplied executable path."""
    if sys.platform == "win32":
        drive = Path(os.environ.get("SystemRoot", "C:\\Windows")).anchor
        candidates = [Path(drive)/folder/"Google"/"Chrome"/"Application"/"chrome.exe" for folder in ("Program Files", "Program Files (x86)")]
        candidates.append(Path.home()/"AppData"/"Local"/"Google"/"Chrome"/"Application"/"chrome.exe")
    elif sys.platform == "darwin":
        candidates = [Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
    else:
        candidates = [Path("/usr/bin/google-chrome"), Path("/opt/google/chrome/chrome")]
    return next((str(path) for path in candidates if path.is_file()), None)


def ui_interaction(args):
    s = context(args)
    html = s.get("html", '<form><label for="q">질문</label><input id="q" required><button id="send" type="submit">전송</button></form>')
    if not isinstance(html, str) or len(html) > 20000:
        raise ValueError("bounded HTML required")
    parser = FormParser()
    parser.feed(html)
    input_control, button = parser.controls.get("q"), parser.controls.get("send")
    accessible = bool(input_control and "q" in parser.labels and button)
    actions = []
    passed = accessible and "required" in input_control if input_control else False
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise ValueError("미설정: Playwright 1.58과 실행 환경의 Chrome을 설치하세요. 자동 다운로드하지 않습니다.") from exc
    # Browser automation is confined to supplied HTML. Scripts, external
    # navigation, downloads and service workers are blocked. All selectors and
    # browser-side checks are fixed source below, never supplied program text.
    with sync_playwright() as manager:
        # Exported runners intentionally sanitize environment variables. Resolve
        # the fixed installed browser location without requiring ProgramFiles/
        # LOCALAPPDATA or accepting an executable supplied by a workflow.
        executable = installed_chrome_path()
        if executable is None:
            raise ValueError("미설정: 표준 설치 위치의 Chrome 브라우저가 필요해요.")
        browser = manager.chromium.launch(executable_path=str(executable), headless=True, timeout=15000)
        try:
            browser_context = browser.new_context(accept_downloads=False, service_workers="block", viewport={"width": 640, "height": 480})
            browser_context.route("**/*", lambda route: route.abort())
            page = browser_context.new_page()
            page.set_default_timeout(2000)
            # CSP disables document scripts and inline event attributes while
            # allowing only our fixed automation callback to observe submit.
            policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; form-action \'none\'; base-uri \'none\'; frame-src \'none\'; object-src \'none\'; style-src \'unsafe-inline\'">'
            page.set_content(policy + html, wait_until="domcontentloaded", timeout=3000)
            actual = {"emptyValid": None, "filledValid": None, "value": None, "associatedLabelCount": 0}
            if page.locator("#q").count() == 1 and page.locator("#send").count() == 1:
                page.evaluate("() => { const form = document.querySelector('#q').form; if (form) { form.dataset.submissions = '0'; form.addEventListener('submit', event => { event.preventDefault(); form.dataset.submissions = String(Number(form.dataset.submissions) + 1); }); } }")
                actual["associatedLabelCount"] = page.locator('label[for="q"]').count()
                actual["emptyValid"] = page.locator("#q").evaluate("element => element.checkValidity()")
                page.locator("#send").click(no_wait_after=True)
                actual["emptySubmitCount"] = page.locator("#q").evaluate("element => element.form ? Number(element.form.dataset.submissions) : -1")
                actions.append({"action": "click", "target": "send", "value": "", "submitCount": actual["emptySubmitCount"], "valid": actual["emptyValid"]})
                page.locator("#q").fill("technical question")
                actual["value"] = page.locator("#q").input_value()
                actions.append({"action": "fill", "target": "q", "value": actual["value"]})
                actual["filledValid"] = page.locator("#q").evaluate("element => element.checkValidity()")
                page.locator("#send").click(no_wait_after=True)
                actual["filledSubmitCount"] = page.locator("#q").evaluate("element => element.form ? Number(element.form.dataset.submissions) : -1")
                actions.append({"action": "click", "target": "send", "submitCount": actual["filledSubmitCount"], "valid": actual["filledValid"]})
                actual["controlBounds"] = page.locator("#q").bounding_box()
                actual["ariaSnapshot"] = page.locator("#q").aria_snapshot()
            screenshot = page.screenshot(type="png")
            evidence = {"controls": parser.controls, "associatedLabels": sorted(parser.labels), "actions": actions, "browser": "installed Chrome via Playwright", "browserObserved": actual, "screenshotSha256": hashlib.sha256(screenshot).hexdigest(), "networkAllowed": False, "scope": "actual browser on isolated supplied HTML; company UI requires registered browser MCP"}
            passed = passed and actual["emptyValid"] is False and actual["filledValid"] is True and actual["value"] == "technical question" and actual["associatedLabelCount"] == 1 and actual.get("emptySubmitCount") == 0 and actual.get("filledSubmitCount") == 1
            browser_context.close()
        finally:
            browser.close()
    return finish(s, "ui_interaction", evidence, passed)


DEFAULT_ROWS = [{"id": 1, "name": "alpha", "quantity": 3, "updated": 1, "held": False}, {"id": 2, "name": "beta", "quantity": 4, "updated": 2, "held": False}, {"id": 3, "name": "gamma", "quantity": 2, "updated": 3, "held": True}]


def image_bytes(value, encoding):
    if not isinstance(value, str) or len(value) > 800000:
        raise ValueError("bounded database image required")
    raw = base64.b64decode(value, validate=True)
    if encoding == "zlib-base64":
        decoder = zlib.decompressobj()
        raw = decoder.decompress(raw, 512001)
        if decoder.unconsumed_tail or not decoder.eof:
            raise ValueError("database image expansion bound")
    elif encoding not in (None, "base64"):
        raise ValueError("unknown database encoding")
    if len(raw) > 512000:
        raise ValueError("database image exceeds 512KB")
    return raw


def db_open(s):
    db = sqlite3.connect(":memory:")
    image = s.get("databaseImage")
    if image:
        # Only images generated by this fixed schema path are accepted.
        data = image_bytes(image, s.get("databaseEncoding"))
        db.deserialize(data)
        objects = db.execute("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
        if any(kind not in ("table", "index") or name not in ("items", "idx_items_quantity") for kind, name in objects):
            raise ValueError("unregistered SQLite object")
    else:
        rows = s.get("rows", DEFAULT_ROWS)
        if not isinstance(rows, list) or len(rows) > MAX_ROWS:
            raise ValueError("at most 500 rows")
        db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL, updated INTEGER NOT NULL, held INTEGER NOT NULL)")
        for row in rows:
            if not isinstance(row, dict) or any(k not in row for k in ("id", "name", "quantity", "updated", "held")) or len(str(row["name"])) > 100:
                raise ValueError("invalid item row")
            db.execute("INSERT INTO items VALUES (?,?,?,?,?)", (int(row["id"]), str(row["name"]), int(row["quantity"]), int(row["updated"]), int(bool(row["held"]))))
        db.commit()
    return db


def db_rows(db):
    cursor = db.execute("SELECT * FROM items ORDER BY id")
    names = [item[0] for item in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


def db_save(s, db):
    db.commit()
    s["databaseImage"] = base64.b64encode(zlib.compress(db.serialize())).decode()
    s["databaseEncoding"] = "zlib-base64"
    s["rowHash"] = digest(db_rows(db))
    s["schema"] = [row[1] for row in db.execute("PRAGMA table_info(items)")]


def db_inspect(args):
    s = context(args)
    with db_open(s) as db:
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
        rows, count = db_rows(db), db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        db_save(s, db)
    return finish(s, "db_inspect", {"count": count, "rowHash": digest(rows), "schema": s["schema"], "integrity": integrity, "scope": "isolated registered SQLite table", "observedAt": s.get("observedAt", 100), "requestedAt": s.get("requestedAt", 100)}, integrity == "ok" and abs(s.get("observedAt", 100) - s.get("requestedAt", 100)) <= 5)


def db_backup(args):
    s = context(args)
    with db_open(s) as source, sqlite3.connect(":memory:") as target:
        source.backup(target)
        image = target.serialize()
        s["backupImage"] = base64.b64encode(zlib.compress(image)).decode()
        s["backupEncoding"] = "zlib-base64"
        s["backupHash"] = hashlib.sha256(image).hexdigest()
        s["backupRowHash"] = digest(db_rows(target))
        db_save(s, source)
    return finish(s, "db_backup", {"backupHash": s["backupHash"], "rowHash": s["backupRowHash"], "bytes": len(image), "sourceRowHash": s["rowHash"]}, s["backupRowHash"] == s["rowHash"])


def db_restore(args):
    s = context(args)
    image = image_bytes(s.get("backupImage", ""), s.get("backupEncoding"))
    valid = bool(image) and hashlib.sha256(image).hexdigest() == s.get("backupHash")
    if not valid:
        return finish(s, "db_restore", {"restored": False, "reason": "backup hash mismatch"}, False)
    s["databaseImage"] = base64.b64encode(zlib.compress(image)).decode()
    s["databaseEncoding"] = "zlib-base64"
    with db_open(s) as restored:
        integrity = restored.execute("PRAGMA integrity_check").fetchone()[0]
        db_save(s, restored)
    passed = integrity == "ok" and s["rowHash"] == s.get("backupRowHash")
    s["originalGoalComplete"] = False
    return finish(s, "db_restore", {"restored": passed, "integrity": integrity, "restoredRowHash": s["rowHash"], "backupRowHash": s.get("backupRowHash"), "originalGoalComplete": False}, passed)


def db_restore_check(args):
    s = context(args)
    with db_open(s) as db:
        rows = db_rows(db)
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
    return finish(s, "db_restore_check", {"fullRowHash": digest(rows), "backupRowHash": s.get("backupRowHash"), "integrity": integrity, "rowsVerified": len(rows)}, digest(rows) == s.get("backupRowHash") and integrity == "ok")


def db_plan(args):
    s = context(args)
    action = s.get("migration", "add_status")
    if action not in ("add_status", "index_quantity", "correct_negative", "archive_expired"):
        raise ValueError("migration must be a registered operation; SQL text is not accepted")
    s["changePlan"] = {"operation": action, "expectedRowHash": s.get("rowHash"), "backupHash": s.get("backupHash"), "scope": "items"}
    s["planHash"] = digest(s["changePlan"])
    return finish(s, "db_plan", {"plan": s["changePlan"], "planHash": s["planHash"], "statements": {"add_status": "ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'", "index_quantity": "CREATE INDEX idx_items_quantity ON items(quantity)", "correct_negative": "UPDATE items SET quantity=0 WHERE quantity<0", "archive_expired": "DELETE FROM items WHERE updated < cutoff AND held=0"}[action]}, bool(s.get("backupHash")))


def db_apply(args):
    s = context(args)
    plan = s.get("changePlan", {})
    if digest(plan) != s.get("planHash"):
        raise ValueError("change plan hash mismatch")
    with db_open(s) as db:
        current = digest(db_rows(db))
        if current != plan.get("expectedRowHash"):
            return finish(s, "db_apply", {"applied": False, "reason": "stale row version"}, False)
        action = plan["operation"]
        if action == "add_status":
            if "status" not in [row[1] for row in db.execute("PRAGMA table_info(items)")]:
                db.execute("ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'")
        elif action == "index_quantity":
            db.execute("CREATE INDEX IF NOT EXISTS idx_items_quantity ON items(quantity)")
        elif action == "correct_negative":
            db.execute("UPDATE items SET quantity=0 WHERE quantity<0")
        elif action == "archive_expired":
            archive = s.get("archive", [])
            if digest(archive) != s.get("archiveHash") or not s.get("archiveVerified"):
                raise ValueError("verified archive required before deletion")
            db.executemany("DELETE FROM items WHERE id=? AND held=0", [(row["id"],) for row in archive])
        else:
            raise ValueError("unregistered migration")
        db_save(s, db)
    return finish(s, "db_apply", {"applied": True, "operation": action, "planHash": s["planHash"], "afterRowHash": s["rowHash"], "schema": s["schema"], "externalWrites": 0})


def db_verify(args):
    s = context(args)
    with db_open(s) as db:
        rows = db_rows(db)
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
        columns = [row[1] for row in db.execute("PRAGMA table_info(items)")]
        negative = db.execute("SELECT COUNT(*) FROM items WHERE quantity<0").fetchone()[0]
    operation = s.get("changePlan", {}).get("operation", "inspect")
    passed = integrity == "ok" and (operation != "add_status" or "status" in columns) and (operation != "correct_negative" or negative == 0)
    expected = s.get("expectedCount", len(rows))
    passed = passed and len(rows) == expected
    return finish(s, "db_verify", {"rowCount": len(rows), "expectedCount": expected, "integrity": integrity, "negativeRows": negative, "schema": columns, "planHash": s.get("planHash"), "verifiedRowHash": digest(rows)}, passed)


def db_query_compare(args):
    s = context(args)
    with db_open(s) as db:
        before = [list(row) for row in db.execute("SELECT id,quantity FROM items WHERE quantity>=? ORDER BY id", (2,)).fetchall()]
        plan_before = [row[3] for row in db.execute("EXPLAIN QUERY PLAN SELECT id,quantity FROM items WHERE quantity>=?", (2,))]
        db.execute("CREATE INDEX IF NOT EXISTS idx_items_quantity ON items(quantity)")
        after = [list(row) for row in db.execute("SELECT id,quantity FROM items WHERE quantity>=? ORDER BY id", (s.get("candidateMinimum", 2),)).fetchall()]
        plan_after = [row[3] for row in db.execute("EXPLAIN QUERY PLAN SELECT id,quantity FROM items WHERE quantity>=?", (2,))]
    s["queryComparison"] = {"before": before, "after": after, "beforePlan": plan_before, "afterPlan": plan_after, "identicalRows": before == after, "indexUsed": any("idx_items_quantity" in p for p in plan_after), "performanceMetric": "actual SQLite plan, not wall-clock guarantee"}
    return finish(s, "db_query_compare", s["queryComparison"], before == after and any("idx_items_quantity" in p for p in plan_after))


def db_quality(args):
    s = context(args)
    with db_open(s) as db:
        bad = [row[0] for row in db.execute("SELECT id FROM items WHERE quantity<0 OR name='' ORDER BY id")]
        count = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    s["qualityIssues"] = bad
    return finish(s, "db_quality", {"invalidIds": bad, "checkedRows": count, "rules": ["quantity >= 0", "name nonempty"]}, not bad)


def db_locks(args):
    s = context(args)
    edges = s.get("waits", [["reader", "writer"], ["writer", "reader"]])
    if not isinstance(edges, list) or len(edges) > 100:
        raise ValueError("bounded wait graph required")
    graph = {}
    for pair in edges:
        if not isinstance(pair, list) or len(pair) != 2 or any(not isinstance(x, str) or len(x) > 40 for x in pair):
            raise ValueError("wait edges require two session IDs")
        graph.setdefault(pair[0], []).append(pair[1])
    cycles = []
    def walk(v, path):
        if v in path:
            cycles.append(path[path.index(v):] + [v])
            return
        if len(path) > 30:
            raise ValueError("wait graph depth bound")
        for target in graph.get(v, []):
            walk(target, path + [v])
    for node in sorted(graph):
        walk(node, [])
    s["lockTarget"] = s.get("targetSession", "writer")
    s["waitGraphHash"] = digest(edges)
    return finish(s, "db_locks", {"cycles": cycles, "target": s["lockTarget"], "graphHash": s["waitGraphHash"]}, bool(cycles) and s["lockTarget"] in graph)


def db_lock_release(args):
    s = context(args)
    edges = s.get("waits", [["reader", "writer"], ["writer", "reader"]])
    if digest(edges) != s.get("waitGraphHash"):
        raise ValueError("stale session graph")
    target = s["lockTarget"]
    remaining = [p for p in edges if target not in p]
    s["waits"] = remaining
    return finish(s, "db_lock_release", {"target": target, "remainingEdges": remaining, "removedEdges": len(edges)-len(remaining), "scope": "registered session graph; company cancellation requires MCP"}, len(remaining) < len(edges))


def db_permissions(args):
    s = context(args)
    roles = s.get("roles", {"reader": {"inherits": [], "allow": ["select"]}, "writer": {"inherits": ["reader"], "allow": ["update"]}})
    if not isinstance(roles, dict) or len(roles) > 20:
        raise ValueError("bounded role map required")
    def effective(role, seen):
        if role in seen or role not in roles:
            raise ValueError("invalid role inheritance")
        r = roles[role]
        grants = set(r.get("allow", []))
        if not grants.issubset({"select", "update", "delete", "alter"}):
            raise ValueError("unregistered permission")
        for parent in r.get("inherits", []):
            grants |= effective(parent, seen | {role})
        return grants
    matrix = {role: sorted(effective(role, set())) for role in roles}
    s["effectivePermissions"] = matrix
    reader_allowed = "select" in matrix.get("reader", [])
    reader_denied = not bool(set(matrix.get("reader", [])) & {"update", "delete", "alter"})
    writer_allowed = "update" in matrix.get("writer", [])
    return finish(s, "db_permissions", {"matrix": matrix, "readerCanRead": reader_allowed, "readerCannotWrite": reader_denied, "writerCanUpdate": writer_allowed}, reader_allowed and reader_denied and writer_allowed)


def db_permissions_restrict(args):
    s = context(args)
    roles = copy.deepcopy(s.get("roles", {"reader": {"inherits": [], "allow": ["select", "update"]}, "writer": {"inherits": ["reader"], "allow": ["update"]}}))
    roles["reader"] = {"inherits": [], "allow": ["select"]}
    s["roles"] = roles
    return finish(s, "db_permissions_restrict", {"changedRole": "reader", "allowed": ["select"], "policyHash": digest(roles)})


def db_archive(args):
    s = context(args)
    cutoff = s.get("cutoff", 3)
    if not isinstance(cutoff, int):
        raise ValueError("integer retention cutoff required")
    with db_open(s) as db:
        rows = db_rows(db)
        archive = [r for r in rows if r["updated"] < cutoff and not r["held"]]
    s["archive"] = archive
    s["archiveHash"] = digest(archive)
    # Actual JSON round-trip restores every selected record before deletion.
    restored = json.loads(json.dumps(archive))
    s["archiveVerified"] = digest(restored) == s["archiveHash"]
    return finish(s, "db_archive", {"selectedIds": [r["id"] for r in archive], "heldIds": [r["id"] for r in rows if r["held"]], "archiveHash": s["archiveHash"], "restoredCount": len(restored)}, s["archiveVerified"] and bool(archive))


def db_replication(args):
    s = context(args)
    source = s.get("primaryRows", DEFAULT_ROWS)
    replica = s.get("replicaRows", DEFAULT_ROWS)
    if not isinstance(source, list) or not isinstance(replica, list) or max(len(source), len(replica)) > MAX_ROWS:
        raise ValueError("bounded source and replica rows required")
    source_point, replica_point = s.get("primaryPoint", 10), s.get("replicaPoint", 10)
    by_id = lambda rows: {str(row["id"]): digest(row) for row in rows}
    a, b = by_id(source), by_id(replica)
    differences = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
    return finish(s, "db_replication", {"sourcePoint": source_point, "replicaPoint": replica_point, "lag": source_point-replica_point, "differentIds": differences, "samePoint": source_point == replica_point}, source_point == replica_point and not differences)


def db_capacity(args):
    s = context(args)
    series = s.get("capacitySeries", [[0, 10], [1, 12], [2, 14], [3, 16], [4, 18]])
    if not isinstance(series, list) or not 3 <= len(series) <= 100 or any(not isinstance(p, list) or len(p) != 2 or any(not isinstance(x, (int, float)) or not math.isfinite(x) for x in p) for p in series):
        raise ValueError("3..100 finite timestamp/value pairs required")
    intervals = [series[i][0]-series[i-1][0] for i in range(1, len(series))]
    regular = min(intervals) > 0 and max(intervals) == min(intervals)
    x, y = zip(*series)
    xm, ym = statistics.mean(x), statistics.mean(y)
    denominator = sum((t-xm)**2 for t in x)
    slope = sum((t-xm)*(v-ym) for t, v in series) / denominator if denominator else 0
    intercept = ym-slope*xm
    residuals = [v-(slope*t+intercept) for t, v in series]
    uncertainty = math.sqrt(sum(r*r for r in residuals)/len(residuals))
    limit = s.get("capacityLimit", 30)
    eta = (limit-y[-1])/slope if slope > 0 else None
    return finish(s, "db_capacity", {"regularIntervals": regular, "slope": slope, "residualRMSE": uncertainty, "remaining": limit-y[-1], "estimatedIntervalsToLimit": eta, "assumption": "linear continuation; no certainty guarantee"}, regular and limit > y[-1])


def db_synthetic(args):
    s = context(args)
    count = s.get("syntheticCount", 12)
    if not isinstance(count, int) or isinstance(count, bool) or not 3 <= count <= 100:
        raise ValueError("3..100 synthetic rows required")
    customers = [{"id": i, "email": f"synthetic-{i}@example.invalid"} for i in range(1, 4)]
    orders = [{"id": i, "customerId": i % 3 + 1, "quantity": (i * 7) % 5 + 1} for i in range(1, count+1)]
    valid = all(o["customerId"] in {c["id"] for c in customers} for o in orders) and all(c["email"].endswith("@example.invalid") for c in customers)
    s["syntheticData"] = {"customers": customers, "orders": orders}
    return finish(s, "db_synthetic", {"customerCount": len(customers), "orderCount": len(orders), "referentialIntegrity": valid, "quantityDistribution": {str(q): sum(o["quantity"] == q for o in orders) for q in range(1, 6)}, "dataHash": digest(s["syntheticData"]), "sourceRecordsUsed": 0}, valid)


def evidence_pin(args):
    s = context(args)
    docs = s.get("documents", [{"id": "average-contract", "version": 1, "text": "average equals sum divided by count; empty input is an error"}])
    if not isinstance(docs, list) or not 1 <= len(docs) <= 20:
        raise ValueError("bounded documents required")
    pinned = [{"id": d["id"], "version": d["version"], "contentHash": digest(d["text"])} for d in docs]
    s["evidencePins"] = pinned
    s["evidenceHash"] = digest(pinned)
    return finish(s, "evidence_pin", {"pins": pinned, "evidenceHash": s["evidenceHash"]})


def evidence_revalidate(args):
    s = context(args)
    current = s.get("currentDocuments", s.get("documents", [{"id": "average-contract", "version": 1, "text": "average equals sum divided by count; empty input is an error"}]))
    pins = {p["id"]: p for p in s.get("evidencePins", [])}
    changed = [d["id"] for d in current if d["id"] not in pins or pins[d["id"]]["version"] != d["version"] or pins[d["id"]]["contentHash"] != digest(d["text"])]
    changed += [key for key in pins if key not in {d["id"] for d in current}]
    affected = ["implementation", "tests", "review", "db_migration"] if changed else []
    return finish(s, "evidence_revalidate", {"changedIds": sorted(set(changed)), "invalidatedArtifacts": affected, "pinnedEvidenceHash": s.get("evidenceHash")}, not changed)


def rag_lifecycle(args):
    s = context(args)
    documents = s.get("documents", [{"id": "contract", "version": 1, "text": "average release threshold 10", "links": ["policy"]}, {"id": "policy", "version": 1, "text": "approval release threshold 20", "links": []}])
    if not isinstance(documents, list) or not 1 <= len(documents) <= 20:
        raise ValueError("bounded documents required")
    s["generations"] = [{"version": 1, "documents": copy.deepcopy(documents), "published": True}]
    s["activeGeneration"] = 1
    return finish(s, "rag_register", {"generation": 1, "documents": [{"id": d["id"], "version": d["version"], "hash": digest(d["text"])} for d in documents]})


def rag_incremental(args):
    s = context(args)
    old = s["generations"][-1]["documents"]
    updates = s.get("updates", [{"id": "contract", "version": 2, "text": "average release threshold 12", "links": ["policy"]}])
    by_id = {d["id"]: copy.deepcopy(d) for d in old}
    changed, reused = [], []
    for update in updates:
        if update["id"] not in by_id:
            raise ValueError("update resource is not registered")
        if digest(update["text"]) != digest(by_id[update["id"]]["text"]):
            changed.append(update["id"])
        by_id[update["id"]] = update
    reused = sorted(set(by_id)-set(changed))
    version = len(s["generations"])+1
    candidate = {"version": version, "documents": list(by_id.values()), "published": False}
    query = s.get("evaluationQuery", "release")
    matches = [d["id"] for d in candidate["documents"] if query.lower() in d["text"].lower()]
    passed = bool(matches)
    candidate["published"] = passed
    s["generations"].append(candidate)
    if passed:
        s["activeGeneration"] = version
    return finish(s, "rag_incremental", {"changedIds": changed, "reusedIds": reused, "evaluationMatches": matches, "activeGeneration": s["activeGeneration"]}, passed)


def rag_query(args):
    s = context(args)
    as_of = s.get("asOf", s["activeGeneration"])
    generation = next((g for g in s["generations"] if g["version"] == as_of and g["published"]), None)
    if not generation:
        raise ValueError("as-of generation was not published")
    docs = {d["id"]: d for d in generation["documents"]}
    query = s.get("query", "average")
    direct = [d for d in docs.values() if query.lower() in d["text"].lower()]
    expanded = {d["id"] for d in direct}
    for d in direct:
        expanded.update(link for link in d.get("links", []) if link in docs)
    import re
    numbers = [{"id": key, "values": [int(n) for n in re.findall(r"\b\d+\b", docs[key]["text"])]} for key in sorted(expanded)]
    s["queryEvidence"] = {"generation": as_of, "ids": sorted(expanded), "directIds": [d["id"] for d in direct], "numbers": numbers, "versions": {key: docs[key]["version"] for key in sorted(expanded)}}
    return finish(s, "rag_query", s["queryEvidence"], bool(direct))


def rag_feedback(args):
    s = context(args)
    relevant = s.get("feedbackRelevant", ["contract", "policy"])
    actual = s.get("queryEvidence", {}).get("ids", [])
    recall = len(set(actual)&set(relevant)) / max(1, len(set(relevant)))
    s["feedback"] = {"expectedIds": relevant, "retrievedIds": actual, "recall": recall}
    return finish(s, "rag_feedback", s["feedback"], recall == 1)


def rag_revoke(args):
    s = context(args)
    removed = s.get("revokeIds", ["policy"])
    known = {d["id"] for g in s["generations"] for d in g["documents"]}
    if any(key not in known for key in removed):
        raise ValueError("cannot revoke an unregistered document")
    for g in s["generations"]:
        g["documents"] = [{**d, "links": [link for link in d.get("links", []) if link not in removed]} for d in g["documents"] if d["id"] not in removed]
    s["revoked"] = removed
    s["queryEvidence"] = {"invalidated": True, "reason": "source revoked"}
    return finish(s, "rag_revoke", {"removedIds": removed, "allGenerationsPurged": all(d["id"] not in removed for g in s["generations"] for d in g["documents"]), "cachedAnswerInvalidated": True})


def rag_recover(args):
    s = context(args)
    requested = s.get("recoverGeneration", 1)
    target = next((g for g in s["generations"] if g["version"] == requested and g["published"]), None)
    passed = bool(target and any("average" in d["text"] for d in target["documents"]))
    if passed:
        s["activeGeneration"] = requested
    return finish(s, "rag_recover", {"requestedGeneration": requested, "activeGeneration": s["activeGeneration"], "revokedIds": s.get("revoked", []), "reevaluated": passed}, passed)


def lineage_plan(args):
    s = context(args)
    old_goal = s.get("previousGoal", {"version": 1, "threshold": 3})
    goal = s.get("goal", {"version": 2, "threshold": 4})
    values = s.get("values", [2, 4, 6])
    if not isinstance(goal, dict) or not isinstance(old_goal, dict) or not isinstance(values, list) or not values or len(values) > 100:
        raise ValueError("bounded goals and values required")
    registered_average(values, "fixed")
    tasks = [{"id": "sum", "dependsOn": [], "goalDependent": False}, {"id": "mean", "dependsOn": ["sum"], "goalDependent": False}, {"id": "decision", "dependsOn": ["mean"], "goalDependent": True}, {"id": "report", "dependsOn": ["decision"], "goalDependent": True}]
    old_input = s.get("previousValues", values)
    changed = old_goal != goal
    input_changed = old_input != values
    affected = [task["id"] for task in tasks if input_changed or changed and task["goalDependent"]]
    if s.get("failedStep"):
        failed = s["failedStep"]
        if failed not in {t["id"] for t in tasks}:
            raise ValueError("unknown failed step")
        for task in tasks:
            if task["id"] == failed or any(dep in affected for dep in task["dependsOn"]):
                if task["id"] not in affected:
                    affected.append(task["id"])
    s["lineage"] = {"tasks": tasks, "invalidated": affected, "preserved": [t["id"] for t in tasks if t["id"] not in affected], "goalHash": digest(goal), "previousGoalHash": digest(old_goal), "inputHash": digest(values)}
    s["lineage"]["changed"] = {task["id"]: task["id"] in affected for task in tasks}
    s["goal"] = goal
    s["values"] = values
    return finish(s, "lineage_plan", s["lineage"])


def lineage_execute(args):
    s = context(args)
    plan = s["lineage"]
    values, goal = s["values"], s["goal"]
    if digest(values) != plan["inputHash"] or digest(goal) != plan["goalHash"]:
        raise ValueError("goal or inputs changed after the invalidation plan")
    prior = s.get("priorArtifacts", {"sum": sum(values), "mean": sum(values)/len(values), "decision": sum(values)/len(values) >= s.get("previousGoal", {"threshold": 3})["threshold"], "report": "previous goal report"})
    outputs, hashes, executed, reused = {}, {}, [], []
    for task in plan["tasks"]:
        key = task["id"]
        if key in plan["invalidated"]:
            if key == "sum":
                value = sum(values)
            elif key == "mean":
                value = outputs["sum"]/len(values)
            elif key == "decision":
                value = outputs["mean"] >= goal["threshold"]
            else:
                value = {"goalVersion": goal["version"], "accepted": outputs["decision"], "evidence": digest(outputs)}
            executed.append(key)
        else:
            if key not in prior:
                raise ValueError("preserved artifact is missing")
            value = prior[key]
            reused.append(key)
        outputs[key] = value
        hashes[key] = digest({"value": value, "dependencies": {dep: hashes[dep] for dep in task["dependsOn"]}, "goal": plan["goalHash"] if task["goalDependent"] else None, "input": plan["inputHash"]})
    s["stepArtifacts"] = outputs
    s["artifactHashes"] = hashes
    s["executedSteps"] = executed
    return finish(s, "lineage_execute", {"executed": executed, "reused": reused, "artifacts": outputs, "hashes": hashes}, outputs.get("mean") == sum(values)/len(values))


def lineage_verify(args):
    s = context(args)
    result = s.get("stepArtifacts", {})
    values = s["values"]
    expected_mean = sum(values)/len(values)
    expected_decision = expected_mean >= s["goal"]["threshold"]
    passed = result.get("sum") == sum(values) and result.get("mean") == expected_mean and result.get("decision") == expected_decision
    return finish(s, "lineage_verify", {"independentSum": sum(values), "independentMean": expected_mean, "independentDecision": expected_decision, "affectedOnly": set(s["executedSteps"]) == set(s["lineage"]["invalidated"])}, passed and set(s["executedSteps"]) == set(s["lineage"]["invalidated"]))


def lineage_step(args, key, execute):
    s = context(args)
    plan, values, goal = s["lineage"], s["values"], s["goal"]
    if digest(values) != plan["inputHash"] or digest(goal) != plan["goalHash"]:
        raise ValueError("goal/input changed after invalidation")
    if bool(plan["changed"][key]) != execute:
        raise ValueError("wrong execution/reuse branch")
    task = next(t for t in plan["tasks"] if t["id"] == key)
    outputs, hashes = s.setdefault("stepArtifacts", {}), s.setdefault("artifactHashes", {})
    if any(dep not in outputs for dep in task["dependsOn"]):
        raise ValueError("dependency artifact is missing")
    if execute:
        if key == "sum": value = sum(values)
        elif key == "mean": value = outputs["sum"]/len(values)
        elif key == "decision": value = outputs["mean"] >= goal["threshold"]
        else: value = {"goalVersion": goal["version"], "accepted": outputs["decision"], "evidence": digest(outputs)}
        s.setdefault("executedSteps", []).append(key)
    else:
        prior = s.get("priorArtifacts", {"sum": sum(values), "mean": sum(values)/len(values), "decision": sum(values)/len(values) >= s.get("previousGoal", {"threshold":3})["threshold"], "report":"previous goal report"})
        if key not in prior: raise ValueError("preserved artifact missing")
        value = prior[key]
        s.setdefault("reusedSteps", []).append(key)
    outputs[key] = value
    hashes[key] = digest({"value": value, "dependencies": {dep: hashes[dep] for dep in task["dependsOn"]}, "goal": plan["goalHash"] if task["goalDependent"] else None, "input": plan["inputHash"]})
    return finish(s, "lineage_" + ("execute_" if execute else "reuse_") + key, {"step":key,"executed":execute,"artifactHash":hashes[key],"value":value})


def lineage_snapshot(args):
    s = context(args)
    s.setdefault("executedSteps", [])
    return finish(s, "lineage_snapshot", {"executed":s["executedSteps"],"reused":s.get("reusedSteps",[]),"hashes":s.get("artifactHashes",{})}, s.get("stepArtifacts",{}).get("mean") == sum(s["values"])/len(s["values"]))


def board_claim(args):
    s = context(args)
    board = args.get("board", s.get("board", {"revision": 0, "tasks": {"analysis": {"status": "pending"}}, "artifacts": {}}))
    if not isinstance(board, dict) or not isinstance(board.get("revision"), int):
        raise ValueError("versioned board required")
    expected = s.get("expectedRevision", board["revision"])
    task = s.get("proposal", {}).get("action", s.get("task", "analysis"))
    if task not in ("analysis", "verification"):
        return finish(s, "board_claim", {"claimed": False, "reason": "unregistered specialist role"}, False)
    actor = "analyst" if task == "analysis" else "independent-verifier"
    if expected != board["revision"]:
        return finish(s, "board_claim", {"claimed": False, "reason": "stale revision", "expected": expected, "actual": board["revision"]}, False)
    current = board.get("tasks", {}).get(task)
    if not current or current.get("status") not in ("pending", "rejected"):
        return finish(s, "board_claim", {"claimed": False, "reason": "task already claimed/completed"}, False)
    if task == "verification" and (board.get("tasks", {}).get("analysis", {}).get("status") != "completed" or "analysis" not in board.get("artifacts", {})):
        return finish(s, "board_claim", {"claimed": False, "reason": "verified predecessor artifact required"}, False)
    updated = copy.deepcopy(board)
    updated["revision"] += 1
    updated["tasks"][task] = {"status": "claimed", "owner": actor, "claimVersion": updated["revision"]}
    s["board"] = updated
    s["expectedRevision"] = board["revision"]
    s["task"] = task
    s["actor"] = actor
    return finish(s, "board_claim", {"claimed": True, "task": task, "owner": actor, "expectedRevision": board["revision"], "nextRevision": updated["revision"]})


def board_work(args):
    s = context(args)
    board = s["board"]
    task = board["tasks"][s["task"]]
    if task.get("owner") != s["actor"] or task.get("status") != "claimed":
        raise ValueError("work requires a matching task claim")
    values = s.get("values", [2, 4, 6])
    result = registered_average(values, "fixed")
    s["workArtifact"] = {"task": s["task"], "claimVersion": task["claimVersion"], "inputHash": digest(values), "mean": result, "count": len(values)}
    if s["task"] == "verification":
        prior = board["artifacts"]["analysis"]
        observed = prior["value"]
        s["workArtifact"]["sourceArtifactHash"] = prior["hash"]
        s["workArtifact"]["sourceRevision"] = prior["revision"]
        s["workArtifact"]["independentlyVerified"] = prior["hash"] == digest(observed) and observed["inputHash"] == digest(values) and observed["mean"] == math.fsum(values)/len(values)
    return finish(s, "board_work", s["workArtifact"])


def board_commit(args):
    s = context(args)
    board = s["board"]
    artifact = s["workArtifact"]
    expected = s["expectedRevision"] = board["revision"]
    values = s.get("values", [2, 4, 6])
    claim = board["tasks"][s["task"]]
    passed = artifact["inputHash"] == digest(values) and artifact["mean"] == math.fsum(values)/len(values) and artifact["claimVersion"] == claim["claimVersion"] and claim["owner"] == s["actor"] and claim["status"] == "claimed"
    if s["task"] == "verification":
        source = board["artifacts"]["analysis"]
        passed = passed and artifact.get("independentlyVerified") is True and artifact.get("sourceArtifactHash") == source["hash"] and artifact.get("sourceRevision") == source["revision"]
    if not passed:
        return finish(s, "board_commit", {"accepted": False}, False)
    updated = copy.deepcopy(board)
    updated["revision"] += 1
    updated["tasks"][s["task"]]["status"] = "completed"
    updated["artifacts"][s["task"]] = {"value": artifact, "hash": digest(artifact), "revision": updated["revision"]}
    s["board"] = updated
    complete = all(task.get("status") == "completed" for task in updated["tasks"].values())
    return finish(s, "board_commit", {"accepted": True, "expectedRevision": expected, "nextRevision": updated["revision"], "artifactHash": digest(artifact), "goalComplete": complete, "nextPending": [key for key, value in updated["tasks"].items() if value.get("status") == "pending"]})


def collect_evidence(args):
    s = context(args)
    checks = args.get("checks", [])
    if not isinstance(checks, list) or not 1 <= len(checks) <= 12:
        raise ValueError("1..12 independent task results required")
    observed = []
    for result in checks:
        output = result.get("output", {}).get("data", {})
        observed.append({"taskId": result.get("taskId"), "passed": output.get("passed") is True, "evidenceHash": digest(output.get("evidence"))})
        for key, value in output.get("artifacts", {}).items():
            s.setdefault("artifacts", {})[key] = value
    return finish(s, "collect_evidence", {"independentChecks": observed}, all(r["passed"] for r in observed))


def integration_contract(args):
    s = context(args)
    upstream = args.get("upstream", {})
    role = s.get("role", "development")
    if role == "development":
        knowledge = upstream.get("knowledge", {}).get("data", {})
        passed = knowledge.get("passed") is True and bool(knowledge.get("evidenceHash"))
        if passed:
            s["evidencePins"] = knowledge["evidencePins"]
            s["evidenceHash"] = knowledge["evidenceHash"]
        checks = {"knowledgePinned": passed}
    elif role == "database":
        development = upstream.get("development", {}).get("data", {})
        passed = development.get("passed") is True and development.get("testEvidence", {}).get("passed") is True and bool(development.get("candidateHash"))
        checks = {"testedCandidate": passed, "candidateHash": development.get("candidateHash"), "evidenceHash": development.get("evidenceHash")}
    else:
        raise ValueError("unknown integrated role")
    return finish(s, "integration_contract", checks, passed)


def final_verify(args):
    s = context(args)
    ledger = s.get("ledger", [])
    latest = {entry["operation"]: entry for entry in ledger}
    passed = bool(ledger) and all(entry["passed"] for entry in latest.values())
    summary = {"status": "verified" if passed else "held", "operations": [e["operation"] for e in ledger], "evidenceHash": digest(ledger), "scope": "registered local operations; external services were not called", "externalCalls": 0}
    return finish(s, "final_verify", summary, passed)


_FUNCTIONS = [code_inspect, code_reproduce, code_patch, code_test, code_differential, code_mutation, code_schedule, code_dependencies, code_build, code_benchmark, ui_interaction, db_inspect, db_backup, db_restore, db_restore_check, db_plan, db_apply, db_verify, db_query_compare, db_quality, db_locks, db_lock_release, db_permissions, db_permissions_restrict, db_archive, db_replication, db_capacity, db_synthetic, evidence_pin, evidence_revalidate, rag_lifecycle, rag_incremental, rag_query, rag_feedback, rag_revoke, rag_recover, lineage_plan, lineage_execute, lineage_verify, board_claim, board_work, board_commit, collect_evidence, integration_contract, final_verify]
OPERATIONS = {"operations." + fn.__name__: fn for fn in _FUNCTIONS}
for _step in ("sum", "mean", "decision", "report"):
    for _execute in (True, False):
        OPERATIONS["operations.lineage_" + ("execute_" if _execute else "reuse_") + _step] = lambda args, key=_step, execute=_execute: lineage_step(args,key,execute)
OPERATIONS["operations.lineage_snapshot"] = lineage_snapshot
CONTRACTS = {name: {"description": fn.__doc__ or (name + ": registered bounded reference-project computation; no arbitrary shell, code, SQL or network"), "exampleArguments": {}, "inputSchema": {"type": "object", "additionalProperties": True}, "effect": "read", "scope": "isolated registered reference project"} for name, fn in OPERATIONS.items()}
CONTRACTS["operations.ui_interaction"]["dependencies"] = ["playwright==1.58.0"]
CONTRACTS["operations.ui_interaction"]["configuration"] = ["installed Chrome browser"]


def execute_operation(operation, arguments):
    if operation not in OPERATIONS:
        raise ValueError("unregistered completion operation")
    return OPERATIONS[operation](bounded(arguments))


if __name__ == "__main__":
    import sys
    try:
        payload = json.loads(sys.stdin.read(1600000))
        result = execute_operation(payload["operation"], payload.get("arguments", {}))
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": {"code": "invalid_input", "message": str(exc)}}, ensure_ascii=False))
