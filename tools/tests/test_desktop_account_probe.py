"""Offline native-auth probe checks: synthetic credentials, no Mac login attempts."""
import hashlib
import importlib.util
import io
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'desktop_account_probe.py'
spec = importlib.util.spec_from_file_location('desktop_account_probe', SOURCE)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

PRIME = (1 << 127) - 1
SIZE = 16
GENERATOR = 5
SERVER_PRIVATE = 7
SERVER_PUBLIC = pow(GENERATOR, SERVER_PRIVATE, PRIME)
BANNER = b'RFB 003.889\n'


class Peer:
    def __init__(self, incoming):
        self.incoming = bytearray(incoming)
        self.sent = bytearray()

    def settimeout(self, value):
        if value <= 0:
            raise AssertionError('Unbounded/expired I/O timeout')

    def recv(self, length):
        count = min(length, 3)  # Fragment every protocol field.
        result = bytes(self.incoming[:count])
        del self.incoming[:count]
        return result

    def sendall(self, data):
        self.sent.extend(data)


def exchange(generator=GENERATOR, size=SIZE, remote=SERVER_PUBLIC, result=0, name=b'fixture'):
    return (BANNER + b'\x03\x21\x1e\x02' + struct.pack('>HH', generator, size)
            + PRIME.to_bytes(SIZE, 'big') + remote.to_bytes(SIZE, 'big')
            + struct.pack('>I', result) + b'\0' * 20 + struct.pack('>I', len(name)) + name)


class ProtocolTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'darwin', 'CommonCrypto is macOS-only')
    def test_aes_known_vector_and_inverse(self):
        key = bytes.fromhex('000102030405060708090a0b0c0d0e0f')
        clear = bytes.fromhex('00112233445566778899aabbccddeeff')
        encrypted = bytes.fromhex('69c4e0d86a7b0430d8cdb78070b4c55a')
        self.assertEqual(probe.aes_ecb(clear, key), encrypted)
        self.assertEqual(probe.aes_ecb(encrypted, key, decrypt=True), clear)

    @unittest.skipUnless(sys.platform == 'darwin', 'CommonCrypto is macOS-only')
    def test_exact_ard_exchange_sends_only_encrypted_authentication(self):
        peer = Peer(exchange())
        probe.account_signin(peer, b'fixture-user', b'fixture-password')
        wire = peer.sent
        self.assertEqual(wire[:13], BANNER + b'\x1e')
        self.assertEqual(len(wire), 12 + 1 + 128 + SIZE)
        public = int.from_bytes(wire[141:141 + SIZE], 'big')
        self.assertTrue(2 <= public < PRIME - 1)
        shared = pow(public, SERVER_PRIVATE, PRIME).to_bytes(SIZE, 'big')
        clear = probe.aes_ecb(wire[13:141], hashlib.md5(shared).digest(), decrypt=True)
        self.assertEqual(clear[:64].split(b'\0', 1)[0], b'fixture-user')
        self.assertEqual(clear[64:].split(b'\0', 1)[0], b'fixture-password')
        self.assertNotIn(b'fixture-password', wire)
        self.assertEqual(peer.incoming, b'\0' * 20 + struct.pack('>I', 7) + b'fixture')

    def test_invalid_credentials_fail_before_any_wire_io(self):
        for username, password in [(b'', b'p'), (b'u', b''), (b'u' * 64, b'p'),
                                   (b'u', b'p' * 64), (b'u\0x', b'p'), (b'u', b'p\0x')]:
            with self.subTest(username_length=len(username), password_length=len(password)):
                peer = Peer(b'')
                with self.assertRaises(probe.ProbeError):
                    probe.account_signin(peer, username, password)
                self.assertEqual(peer.sent, b'')

    def test_only_apple_banner_is_accepted(self):
        peer = Peer(b'RFB 003.008\n' + exchange()[12:])
        with self.assertRaisesRegex(probe.ProbeError, 'protocol'):
            probe.account_signin(peer, b'u', b'p')
        self.assertEqual(peer.sent, b'')

    def test_no_fallback_to_vnc_or_other_security(self):
        peer = Peer(BANNER + b'\x02\x02\x21')
        with self.assertRaisesRegex(probe.ProbeError, 'no fallback'):
            probe.account_signin(peer, b'u', b'p')
        self.assertEqual(peer.sent, BANNER)

    def test_invalid_dh_parameters_abort_before_credentials(self):
        for kwargs in [{'size': 0}, {'size': 513}, {'generator': 0}, {'generator': 1},
                       {'remote': 0}, {'remote': 1}, {'remote': PRIME - 1}]:
            with self.subTest(kwargs=kwargs):
                peer = Peer(exchange(**kwargs))
                with self.assertRaises(probe.ProbeError):
                    probe.account_signin(peer, b'u', b'p')
                self.assertEqual(peer.sent, BANNER + b'\x1e')

    def test_rejection_is_generic_and_does_not_retry_or_initialize(self):
        peer = Peer(exchange(result=1, name=b'native secret reason'))
        with patch.object(probe, 'aes_ecb', return_value=bytearray(128)):
            with self.assertRaisesRegex(probe.ProbeError, '^The Mac rejected account sign-in. No retry was attempted.$'):
                probe.account_signin(peer, b'u', b'p')
        self.assertEqual(len(peer.sent), 12 + 1 + 128 + SIZE)

    def test_truncated_and_expired_reads_abort(self):
        with self.assertRaisesRegex(probe.ProbeError, 'closed'):
            probe.account_signin(Peer(BANNER[:7]), b'u', b'p')
        with patch.object(probe.time, 'monotonic', return_value=10):
            with self.assertRaisesRegex(probe.ProbeError, 'timed out'):
                probe.read_exact(Peer(b'x'), 1, 9)

    def test_accepted_authentication_needs_no_server_init(self):
        peer = Peer(exchange()[:-(24 + 7)])
        with patch.object(probe, 'aes_ecb', return_value=bytearray(128)):
            probe.account_signin(peer, b'u', b'p')
        self.assertEqual(peer.incoming, b'')
        self.assertEqual(len(peer.sent), 12 + 1 + 128 + SIZE)


class LockPolicyTests(unittest.TestCase):
    def test_only_own_active_unambiguous_console_is_used(self):
        own = {'kCGSSessionUserIDKey': 501, 'kCGSSessionOnConsoleKey': True}
        self.assertFalse(probe.lock_state([own], 501))
        self.assertTrue(probe.lock_state([{**own, 'CGSSessionScreenIsLocked': True}], 501))
        self.assertFalse(probe.lock_state([{**own, 'CGSSessionScreenIsLocked': False}], 501))
        for users in [None, {}, [], ['bad'], [{**own, 'kCGSSessionUserIDKey': 502}],
                      [{**own, 'kCGSSessionOnConsoleKey': False}],
                      [{**own, 'CGSSessionScreenIsLocked': 'yes'}], [own, own]]:
            with self.subTest(users=users):
                self.assertIsNone(probe.lock_state(users, 501))

    def test_non_terminal_input_is_rejected_before_credentials(self):
        with patch.object(probe.sys.stdin, 'isatty', return_value=False), \
             patch('builtins.input') as username, patch.object(probe.getpass, 'getpass') as password, \
             patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(probe.main(), 1)
        username.assert_not_called()
        password.assert_not_called()

    def test_unlock_race_and_unknown_console_never_authenticate(self):
        for states in [[True, False], [None]]:
            with self.subTest(states=states), \
                 patch.object(probe.sys.stdin, 'isatty', return_value=True), \
                 patch.object(probe.sys.stderr, 'isatty', return_value=True), \
                 patch.object(probe.resource, 'setrlimit'), \
                 patch('builtins.input', return_value='fixture-user'), \
                 patch.object(probe.getpass, 'getpass', return_value='fixture-password'), \
                 patch.object(probe, 'screen_locked', side_effect=states), \
                 patch.object(probe.socket, 'create_connection') as connect, \
                 patch('sys.stdout', new_callable=io.StringIO) as output:
                self.assertEqual(probe.main(), 1)
                connect.assert_not_called()
                self.assertNotIn('fixture-password', output.getvalue())

    def test_one_loopback_attempt_distinguishes_authentication_from_unlock(self):
        for unlocked in [True, False]:
            states = [True, True, not unlocked, not unlocked]
            with self.subTest(unlocked=unlocked), \
                 patch.object(probe.sys.stdin, 'isatty', return_value=True), \
                 patch.object(probe.sys.stderr, 'isatty', return_value=True), \
                 patch.object(probe.resource, 'setrlimit') as limits, \
                 patch.object(probe.getpass, 'getpass', return_value='fixture-password'), \
                 patch.object(probe, 'screen_locked', side_effect=states), \
                 patch.object(probe.time, 'monotonic', side_effect=[0, 0, 11]), \
                 patch.object(probe.socket, 'create_connection') as connect, \
                 patch.object(probe, 'account_signin') as signin, \
                 patch('sys.stdout', new_callable=io.StringIO) as output:
                def state():
                    if len(states) <= 2:
                        self.assertEqual(set(signin.call_args.args[2]), {0})
                    return states.pop(0)
                with patch.object(probe, 'screen_locked', side_effect=state):
                    self.assertEqual(probe.main(), 0 if unlocked else 2)
                limits.assert_called_once_with(probe.resource.RLIMIT_CORE, (0, 0))
                connect.assert_called_once_with(('127.0.0.1', 5900), timeout=3)
                signin.assert_called_once()
                connect.return_value.__enter__.return_value.sendall.assert_called_once_with(b'\x81')
                # The function receives mutable buffers, overwritten after completion.
                self.assertEqual(set(signin.call_args.args[1]), {0})
                self.assertEqual(set(signin.call_args.args[2]), {0})
                connect.return_value.__exit__.assert_called_once()
                self.assertNotIn('fixture-password', output.getvalue())
                self.assertIn('EXISTING CONSOLE UNLOCKED' if unlocked else 'unlock was not proven', output.getvalue())


if __name__ == '__main__':
    unittest.main()
