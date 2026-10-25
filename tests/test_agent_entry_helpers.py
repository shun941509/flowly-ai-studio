"""Agent helper routing: actual local subprocess, explicit routing fixture, no provider calls."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "export-runtime"


def module(name):
    spec = importlib.util.spec_from_file_location(name, SOURCE / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


ops = module("flowly_ops")
triggers = module("flowly_triggers")


class AgentEntryHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="flowly-agent-helpers-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, language="python"):
        package = {"format": "flowly-executable-export", "version": 1, "language": language,
                   "workflow": {"definition": {"nodes": [{"id": "input", "type": "trigger", "trigger": {"kind": "event", "intervalSeconds": 60}}]}},
                   "limits": {"maxDurationMs": 1000}}
        (self.root / "workflow.json").write_text(json.dumps(package), encoding="utf-8")
        entry = "agent.py" if language == "python" else "agent.mjs"
        manifest = {"format": "flowly-agent-project", "version": 1, "language": language, "entrypoint": entry, "workflow": "workflow.json"}
        (self.root / "agent-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        # Only the subprocess boundary is a fixture; selection, persistence and argv are real.
        source = "import json, sys\nprint(json.dumps({'status':'routing-fixture','args':sys.argv[1:]}))" if language == "python" else "process.stdout.write(JSON.stringify({status:'routing-fixture',args:process.argv.slice(2)}))"
        (self.root / entry).write_text(source, encoding="utf-8")
        return manifest

    def test_operations_and_triggers_dispatch_agent_without_package_override_in_both_languages(self):
        for language in ("python", "node"):
            if language == "node" and not shutil.which("node"):
                continue
            with self.subTest(language=language):
                folder = self.root / language
                folder.mkdir()
                original, self.root = self.root, folder
                try:
                    self.prepare(language)
                    operation = ops.Operations(self.root)
                    result = operation.cli(operation.profile(), ["check"])
                    self.assertEqual(result["status"], "routing-fixture")
                    self.assertNotIn("--package", result["args"])
                    self.assertIn("--state", result["args"])
                    launcher = triggers.Launcher(self.root / "workflow.json", self.root / ".env", self.root / ".triggers")
                    result = launcher.cli(["check"])
                    self.assertEqual(result["status"], "routing-fixture")
                    self.assertNotIn("--package", result["args"])
                    self.assertIn("--env", result["args"])
                finally:
                    self.root = original

    def test_changed_or_removed_agent_manifest_never_falls_back_to_runner(self):
        self.prepare()
        operation = ops.Operations(self.root)
        launcher = triggers.Launcher(self.root / "workflow.json", self.root / ".env", self.root / ".triggers")
        (self.root / "agent-manifest.json").unlink()
        with self.assertRaises(ops.OperationsFault):
            operation.cli(operation.profile(), ["check"])
        with self.assertRaises(triggers.TriggerFault):
            launcher.cli(["check"])
        with self.assertRaises(ops.OperationsFault):
            ops.Operations(self.root)
        with self.assertRaises(triggers.TriggerFault):
            triggers.Launcher(self.root / "workflow.json", self.root / ".env", self.root / ".triggers")

    def test_invalid_language_entrypoint_and_manifest_shape_fail_closed(self):
        for change in ({"language": "node"}, {"entrypoint": "runner.py"}, {"workflow": "alternate.json"}, []):
            with self.subTest(change=change):
                manifest = self.prepare()
                if isinstance(change, dict):
                    manifest.update(change)
                else:
                    manifest = change
                (self.root / "agent-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                with self.assertRaises(ops.OperationsFault):
                    ops.Operations(self.root)
                with self.assertRaises(triggers.TriggerFault):
                    triggers.Launcher(self.root / "workflow.json", self.root / ".env", self.root / ".triggers")


if __name__ == "__main__":
    unittest.main()
