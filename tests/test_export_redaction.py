"""Regression checks for bounded, per-snapshot masking; no provider calls."""
import copy
import importlib.util
import pathlib
import re
import unittest


RUNNER = pathlib.Path(__file__).resolve().parents[1] / "export-runtime" / "runner.py"
SPEC = importlib.util.spec_from_file_location("export_redaction_runner", RUNNER)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
HIDDEN = "[비밀 값 숨김]"


def previous_redact(value, secrets=()):
    """The prior masking contract, retained independently for parity checks."""
    def text(raw):
        for secret in secrets:
            if secret:
                raw = raw.replace(secret, HIDDEN)
        raw = re.sub(r"\bsk-[A-Za-z0-9_-]{12,}\b", HIDDEN, raw)
        return re.sub(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer " + HIDDEN, raw, flags=re.I)
    if isinstance(value, str):
        return text(value)
    if isinstance(value, list):
        return [previous_redact(item, secrets) for item in value]
    if isinstance(value, dict):
        return {text(k): HIDDEN if re.fullmatch(r"authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|client[_-]?secret", k, re.I) else previous_redact(v, secrets) for k, v in value.items()}
    return value


class ExportRedactionTests(unittest.TestCase):
    def test_patterns_private_keys_and_explicit_secrets(self):
        value = {
            "text": "sk-12345678901234567890 | bEaReR abc.xyz-_/+= | LOCAL_VALUE",
            "safe": "sk-short | password_hint | 토큰 없는 문장",
            "nested": [{key: "private" for key in ["AUTHORIZATION", "api_key", "api-key", "accessToken", "refresh_token", "Password", "secret", "client-secret"]}],
            "password_hint": "ordinary",
        }
        result = runner.redact(value, ["", "LOCAL_VALUE"])
        self.assertEqual(result, previous_redact(value, ["", "LOCAL_VALUE"]))
        self.assertEqual(result["text"], f"{HIDDEN} | Bearer {HIDDEN} | {HIDDEN}")
        self.assertTrue(all(item == HIDDEN for item in result["nested"][0].values()))
        self.assertEqual(result["safe"], value["safe"])
        self.assertEqual(result["password_hint"], "ordinary")

    def test_secret_cache_is_discarded_between_calls(self):
        value = {"message": "FIRST_LOCAL SECOND_LOCAL", "rows": ["FIRST_LOCAL SECOND_LOCAL"] * 4}
        first = runner.redact(value, ["FIRST_LOCAL"])
        second = runner.redact(value, ["SECOND_LOCAL"])
        third = runner.redact(value)
        self.assertEqual(first["message"], HIDDEN + " SECOND_LOCAL")
        self.assertEqual(second["message"], "FIRST_LOCAL " + HIDDEN)
        self.assertEqual(third, value)
        self.assertEqual(second, previous_redact(value, ["SECOND_LOCAL"]))

    def test_redacted_key_collisions_keep_existing_last_value_semantics(self):
        value = {"prefix FIRST_LOCAL": 1, "prefix SECOND_LOCAL": 2,
                 "nested": {"sk-aaaaaaaaaaaa": "first", "sk-bbbbbbbbbbbb": "last"},
                 "secret": "never retained"}
        result = runner.redact(value, ["FIRST_LOCAL", "SECOND_LOCAL", "secret"])
        self.assertEqual(result, previous_redact(value, ["FIRST_LOCAL", "SECOND_LOCAL", "secret"]))
        self.assertEqual(result["prefix " + HIDDEN], 2)
        self.assertEqual(result["nested"], {HIDDEN: "last"})
        self.assertEqual(result[HIDDEN], HIDDEN)

    def test_cache_capacity_does_not_skip_later_secrets_or_private_keys(self):
        value = {f"key-{index}": f"value-{index}" for index in range(2300)}
        value["tail"] = {"api_key": "PRIVATE", "message": "LATE_SECRET Bearer tail-token", "key-0": "LATE_SECRET"}
        result = runner.redact(value, ["LATE_SECRET"])
        self.assertEqual(result, previous_redact(value, ["LATE_SECRET"]))
        self.assertEqual(result["tail"], {"api_key": HIDDEN, "message": HIDDEN + " Bearer " + HIDDEN, "key-0": HIDDEN})

    def test_long_values_and_long_keys_still_receive_full_masking(self):
        key = "k" * 300 + "LOCAL_VALUE"
        long_text = "한" * 5000 + " LOCAL_VALUE Bearer abc.def sk-1234567890123456"
        value = {key: [long_text, long_text], "end": "LOCAL_VALUE"}
        result = runner.redact(value, ["LOCAL_VALUE"])
        self.assertEqual(result, previous_redact(value, ["LOCAL_VALUE"]))
        self.assertIn("k" * 300 + HIDDEN, result)
        self.assertNotIn("LOCAL_VALUE", str(result))
        self.assertNotIn("abc.def", str(result))

    def test_nested_input_and_shared_containers_are_not_modified(self):
        shared = {"items": [{"access_token": "private", "number": 2, "flag": True, "empty": None}], "text": "LOCAL_VALUE"}
        value = {"first": shared, "second": shared, "zero": 0}
        original = copy.deepcopy(value)
        result = runner.redact(value, ["LOCAL_VALUE"])
        self.assertEqual(result, previous_redact(value, ["LOCAL_VALUE"]))
        self.assertEqual(value, original)
        result["first"]["items"][0]["number"] = 99
        self.assertEqual(value, original)
        self.assertEqual(result["second"]["items"][0]["number"], 2)


if __name__ == "__main__":
    unittest.main()
