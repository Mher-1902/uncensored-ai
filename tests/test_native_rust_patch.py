"""Guard the private native build overlay; no model or production access."""
from pathlib import Path
import importlib.util
import unittest

path = Path(__file__).resolve().parents[1] / 'scripts/patch-native-rust-input.py'
spec = importlib.util.spec_from_file_location('native_rust_patch', path)
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)


class NativeRustPatchTests(unittest.TestCase):
    def source(self):
        return '// synthetic reviewed-shape fixture\n' + '\n'.join(before for before, _ in patch.PATCHES)

    def test_overlay_is_idempotent_and_preserves_surrounding_source(self):
        source = self.source()
        updated = patch.patch_text(source)
        self.assertEqual(patch.patch_text(updated), updated)
        self.assertEqual(patch.restore_text(updated), source)
        self.assertEqual(updated.count('Offscript Rust prompt-token boundary v1'), 1)
        self.assertEqual(updated.count('props["offscript_input_tokens_version"] = 1;'), 2)
        self.assertEqual(updated.count('props["offscript_erase_state_version"] = 1;'), 2)
        self.assertIn('slot->task_prev.reset();', updated)
        self.assertIn('slot->smpl.reset();', updated)
        self.assertIn('slot->debug_generated_text.clear();', updated)
        self.assertIn('slot->spec_prompt.clear();', updated)
        self.assertIn('slot->spec_draft_q.clear();', updated)

    def test_drift_missing_handlers_and_duplicates_are_rejected(self):
        for source in [
            self.source().replace('json body_parsed =', 'auto body_parsed ='),
            patch.PROPS_BEFORE,
            self.source() + patch.CHAT_BEFORE,
            self.source() + patch.PROPS_BEFORE,
            self.source().replace(patch.ERASE_BEFORE, ''),
            self.source() + patch.ERASE_RESPONSE_BEFORE,
        ]:
            with self.assertRaises(ValueError):
                patch.patch_text(source)

    def test_partial_or_modified_applied_patches_are_rejected(self):
        for source in [
            patch.PROPS_AFTER + patch.CHAT_BEFORE,
            patch.PROPS_BEFORE + patch.CHAT_AFTER,
            patch.PROPS_AFTER + patch.CHAT_AFTER.replace('tokens.size() <= 4096', 'tokens.size() <= 9999'),
            patch.PROPS_AFTER + patch.CHAT_AFTER + patch.CHAT_AFTER,
            self.source().replace(patch.ERASE_BEFORE, patch.ERASE_AFTER),
            patch.patch_text(self.source()).replace('slot->smpl.reset();', '// omitted sampler cleanup'),
            patch.patch_text(self.source()).replace('token.is_number_integer()', 'token.is_number()'),
            patch.patch_text(self.source()).replace('id >= 0.0', 'id >= -1.0'),
        ]:
            with self.assertRaises(ValueError):
                patch.patch_text(source)


if __name__ == '__main__':
    unittest.main()
