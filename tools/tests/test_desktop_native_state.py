"""Compile actual native helper logic with inert display stubs; never mutate macOS."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == 'darwin', 'Native helper is macOS-only')
class NativeStateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[2]
        cls.temp = tempfile.TemporaryDirectory(prefix='kodex-native-state-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.binary = str(Path(cls.temp.name) / 'native-state')
        subprocess.run(['/usr/bin/clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
                        '-framework', 'Foundation', '-framework', 'CoreGraphics', '-framework', 'IOKit',
                        str(root / 'tools/tests/fixtures/desktop_virtual_state.m'),
                        str(root / 'apps/gateway/src/desktop/native/session_lock.m'),
                        '-o', cls.binary], check=True, capture_output=True, text=True, timeout=30)

    def test_conservative_own_console_policy(self):
        subprocess.run([self.binary, 'policy'], check=True, capture_output=True, timeout=5)

    def test_relock_during_readiness_retains_partial_display_and_invalidates_callbacks(self):
        subprocess.run([self.binary, 'lifecycle'], check=True, capture_output=True, timeout=5)
