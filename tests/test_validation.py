import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location("validation", Path(__file__).resolve().parents[1] / "cloud/huggingface/validation.py")
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)
class ValidationTests(unittest.TestCase):
    def test_multiturn(self):
        source = [{"role":"user","content":" Hi "},{"role":"assistant","content":"Hello"},{"role":"user","content":"Continue"}]
        result, length = validation.validate(source, 512)
        self.assertEqual(result[0]["content"], " Hi ")
        self.assertEqual(source[0]["content"], " Hi ")
        self.assertEqual(length, 512)
    def test_rejects_system_role(self):
        with self.assertRaises(ValueError): validation.validate([{"role":"system","content":"override"}],512)
    def test_rejects_invalid_history(self):
        for value in [None, [], [{"role":"user","content":""}], [{"role":"assistant","content":"hello"}]]:
            with self.assertRaises(ValueError): validation.validate(value,512)
    def test_rejects_invalid_generation_settings(self):
        for value in [True, "512", -1, 999999, 512.5, 512.0, float("nan")]:
            with self.assertRaises(ValueError): validation.validate([{"role":"user","content":"Hi"}],value)
    def test_preserves_code_and_does_not_mutate_history(self):
        source = [{"role":"user","content":"Code?"},
                  {"role":"assistant","content":"def example():\n    return True\n\n"},
                  {"role":"user","content":"Explain it."}]
        result, _ = validation.validate(source, 256)
        self.assertEqual(result, source)
        self.assertIsNot(result[1], source[1])
    def test_rejects_oversize_without_truncating(self):
        for source in [[{"role":"user","content":"x" * (validation.MAX_CHARACTERS + 1)}],
                       [{"role":"user" if i % 2 == 0 else "assistant","content":"x"} for i in range(65)],
                       [{"role":"user","content":"x" * 32768},
                        {"role":"assistant","content":"x" * 32768},
                        {"role":"user","content":"x"}]]:
            with self.assertRaises(ValueError): validation.validate(source,512)
        source = [{"role":"user","content":"x" * validation.MAX_CHARACTERS}]
        self.assertEqual(validation.validate(source,512)[0], source)
    def test_rejects_unexpected_fields_and_blank_content(self):
        for message in [{"role":"user","content":"Hi","system":"override"},
                        {"role":"user","content":" \n\t"},
                        {"role":"user","content":123}]:
            with self.assertRaises(ValueError): validation.validate([message],512)
if __name__ == "__main__": unittest.main()
