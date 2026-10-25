"""Test-only MCP boundary: perform real SQLite and fixed Python-fixture operations.

Never shipped in a workflow export. It accepts no SQL, code, command or file path
from a workflow. Synthetic fixtures are isolated by scenario in its working dir.
"""
import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path


def invoke(operation, arguments, scenario):
    key = hashlib.sha256(scenario.encode("utf-8")).hexdigest()[:16]
    root = Path.cwd() / ".p4-fixtures" / key
    root.mkdir(parents=True, exist_ok=True)
    if arguments.get("changeId") != "average-v2":
        raise ValueError("unknown fixture change")
    database = root / "sample.sqlite"
    if not database.exists():
        with sqlite3.connect(database) as db:
            db.execute("CREATE TABLE items(id INTEGER PRIMARY KEY, quantity INTEGER NOT NULL)")
            db.executemany("INSERT INTO items VALUES(?,?)", [(1, 2), (2, 4), (3, 6)])
            db.execute("PRAGMA user_version=1")
    active = root / "active.py"
    if not active.exists():
        active.write_text("def average(values):\n    return sum(values)\n", encoding="utf-8")
    candidate = root / "candidate.py"

    def check_code(path):
        # Fixed test code and fixed file names; no model-generated program executes.
        test = ("import importlib.util\n"
                f"s=importlib.util.spec_from_file_location('sample', {str(path)!r})\n"
                "m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n"
                "assert m.average([2,4,6]) == 4\n"
                "assert m.average([-2,2]) == 0\n"
                "assert m.average([5]) == 5\n"
                "try: m.average([])\n"
                "except ValueError: pass\n"
                "else: raise AssertionError('empty input must fail')\n")
        result = subprocess.run([sys.executable, "-I", "-c", test], capture_output=True, timeout=5)
        return result.returncode == 0

    def inspect_db():
        with sqlite3.connect(database) as db:
            return {"version": db.execute("PRAGMA user_version").fetchone()[0],
                    "rows": db.execute("SELECT count(*) FROM items").fetchone()[0],
                    "quantityTotal": db.execute("SELECT sum(quantity) FROM items").fetchone()[0]}

    if operation == "inspect_code":
        result = {"revision": "code-v1", "testsPassed": check_code(active)}
    elif operation in ("prepare_code_change", "prepare_code_change_failing"):
        if arguments.get("operation") != "fix_average" or arguments.get("sourceVersion") != "2026-10-24T00:00:00Z":
            raise ValueError("unverified fixture implementation contract")
        candidate.write_text("def average(values):\n    if not values:\n        raise ValueError('empty input')\n    return sum(values) / len(values)\n", encoding="utf-8")
        if operation == "prepare_code_change_failing":
            candidate.write_text("def average(values):\n    return 999\n", encoding="utf-8")
        result = {"artifactId": "average-v2", "testsPassed": check_code(candidate), "sourceVersion": arguments["sourceVersion"]}
    elif operation == "apply_code_change":
        if arguments.get("artifactId") != "average-v2" or not candidate.exists() or not check_code(candidate):
            raise ValueError("unverified fixture artifact")
        shutil.copyfile(candidate, active)
        result = {"revision": "code-v2", "applied": True}
    elif operation == "verify_code":
        result = {"revision": "code-v2", "testsPassed": check_code(active)}
    elif operation == "inspect_db":
        result = inspect_db()
    elif operation == "apply_migration":
        if arguments.get("expectedVersion") != 1 or inspect_db()["version"] != 1:
            raise ValueError("fixture schema version conflict")
        with sqlite3.connect(database) as db, sqlite3.connect(root / "backup.sqlite") as backup:
            db.backup(backup)
            db.execute("ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
            db.execute("PRAGMA user_version=2")
        result = {"version": 2, "backupId": "before-average-v2"}
    elif operation in ("verify_db", "verify_db_corrupt"):
        with sqlite3.connect(database) as db:
            if operation == "verify_db_corrupt":
                db.execute("UPDATE items SET quantity=-2 WHERE id=1")
            columns = [row[1] for row in db.execute("PRAGMA table_info(items)")]
            valid_rows = db.execute("SELECT count(*) FROM items WHERE quantity>=0").fetchone()[0]
            result = {"version": db.execute("PRAGMA user_version").fetchone()[0],
                      "verified": "status" in columns and valid_rows == 3 and db.execute("SELECT count(*) FROM items").fetchone()[0] == 3 and db.execute("SELECT sum(quantity) FROM items").fetchone()[0] == 12 and db.execute("PRAGMA user_version").fetchone()[0] == 2,
                      "validRows": valid_rows}
    elif operation == "restore_db":
        if arguments.get("backupId") != "before-average-v2" or not (root / "backup.sqlite").is_file():
            raise ValueError("fixture backup not found")
        with sqlite3.connect(root / "backup.sqlite") as backup, sqlite3.connect(database) as db:
            backup.backup(db)
        state = inspect_db()
        with sqlite3.connect(database) as db:
            original_schema = [row[1] for row in db.execute("PRAGMA table_info(items)")] == ["id", "quantity"]
        result = {**state, "restored": original_schema and state["version"] == 1 and state["rows"] == 3 and state["quantityTotal"] == 12}
    else:
        raise ValueError("unknown local fixture operation")
    with (root / "operations.jsonl").open("a", encoding="utf-8") as log:
        log.write(json.dumps({"operation": operation, "result": result}) + "\n")
    return {"structuredContent": result, "content": [{"type": "text", "text": json.dumps(result)}]}


if __name__ == "__main__":
    payload = json.load(sys.stdin)
    print(json.dumps(invoke(payload["operation"], payload["arguments"], payload["scenario"])))
