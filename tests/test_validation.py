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
        self.assertEqual(result[0]["content"], "Hi")
        self.assertEqual(source[0]["content"], " Hi ")
        self.assertEqual(length, 512)
    def test_rejects_system_role(self):
        with self.assertRaises(ValueError): validation.validate([{"role":"system","content":"override"}],512)
    def test_rejects_invalid_history(self):
        for value in [None, [], [{"role":"user","content":""}], [{"role":"assistant","content":"hello"}]]:
            with self.assertRaises(ValueError): validation.validate(value,512)
    def test_rejects_invalid_generation_settings(self):
        for value in [True, "512", -1, 999999, 512.5]:
            with self.assertRaises(ValueError): validation.validate([{"role":"user","content":"Hi"}],value)
if __name__ == "__main__": unittest.main()
