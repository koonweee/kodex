#!/usr/bin/env python3
"""Manual local ARD-account experiment; never run by gateway agents with real credentials.

Protocol reference: noVNC 1.6.0 core/rfb.js, _negotiateARDAuthAsync
(commit a8dfd6a3ea3c74244f5ebdaa5a7f1023007a7820; MPL-2.0,
Copyright (C) 2020 The noVNC authors). Credentials are entered in the
operator's own Terminal, never argv/environment/config files. One attempt.
"""
import ctypes
import getpass
import hashlib
import os
import plistlib
import pwd
import resource
import secrets
import socket
import struct
import sys
import time
import warnings


class ProbeError(Exception):
    pass


def aes_ecb(data, key, decrypt=False):
    """CommonCrypto AES, no padding; ARD uses a fixed 128-byte credential block."""
    if len(key) != 16 or not data or len(data) % 16:
        raise ProbeError("Invalid native authentication encryption input.")
    library = ctypes.CDLL('/usr/lib/system/libcommonCrypto.dylib')
    crypt = library.CCCrypt
    crypt.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32,
                      ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p,
                      ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p,
                      ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    crypt.restype = ctypes.c_int32
    key_buffer = ctypes.create_string_buffer(bytes(key))
    source = ctypes.create_string_buffer(bytes(data))
    output = ctypes.create_string_buffer(len(data))
    moved = ctypes.c_size_t()
    try:
        # kCCAlgorithmAES=0; kCCOptionECBMode=2; kCCEncrypt=0/kCCDecrypt=1.
        status = crypt(int(decrypt), 0, 2, key_buffer, 16, None,
                       source, len(data), output, len(data), ctypes.byref(moved))
        if status or moved.value != len(data):
            raise ProbeError("Native authentication encryption failed.")
        return bytearray(output.raw)
    finally:
        for buffer in (key_buffer, source, output):
            ctypes.memset(ctypes.addressof(buffer), 0, ctypes.sizeof(buffer))


def read_exact(peer, length, deadline):
    result = bytearray()
    while len(result) < length:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeError("Native authentication timed out.")
        peer.settimeout(remaining)
        block = peer.recv(length - len(result))
        if not block:
            raise ProbeError("Screen Sharing closed the authentication connection.")
        result.extend(block)
    return result


def account_signin(peer, username, password):
    """Authenticate only; acceptance does not prove console initialization/unlock."""
    if (not 1 <= len(username) <= 63 or not 1 <= len(password) <= 63
            or 0 in username or 0 in password):
        raise ProbeError("ARD requires username/password of 1–63 UTF-8 bytes without NUL; nothing was sent.")
    deadline = time.monotonic() + 8
    version = read_exact(peer, 12, deadline)
    if version != b'RFB 003.889\n':
        raise ProbeError("Unsupported Screen Sharing protocol.")
    peer.sendall(version)
    count = read_exact(peer, 1, deadline)[0]
    if not count or 30 not in read_exact(peer, count, deadline):
        raise ProbeError("Screen Sharing did not offer Apple account authentication; no fallback was attempted.")
    peer.sendall(b'\x1e')
    generator, size = struct.unpack('>HH', read_exact(peer, 4, deadline))
    if not 16 <= size <= 512:
        raise ProbeError("Unsupported native authentication key size.")
    prime = int.from_bytes(read_exact(peer, size, deadline), 'big')
    remote = int.from_bytes(read_exact(peer, size, deadline), 'big')
    if prime <= 5 or not 2 <= generator < prime - 1 or not 2 <= remote < prime - 1:
        raise ProbeError("Invalid native authentication exchange.")
    private = secrets.randbelow(prime - 3) + 2
    public = pow(generator, private, prime).to_bytes(size, 'big')
    shared = bytearray(pow(remote, private, prime).to_bytes(size, 'big'))
    key = bytearray(hashlib.md5(shared).digest())
    credentials = bytearray(secrets.token_bytes(128))
    credentials[:len(username)] = username
    credentials[len(username)] = 0
    credentials[64:64 + len(password)] = password
    credentials[64 + len(password)] = 0
    encrypted = None
    try:
        encrypted = aes_ecb(credentials, key)
        peer.sendall(encrypted + public)
    finally:
        for buffer in (credentials, key, shared, encrypted):
            if buffer is not None:
                buffer[:] = b'\0' * len(buffer)
    if struct.unpack('>I', read_exact(peer, 4, deadline))[0] != 0:
        raise ProbeError("The Mac rejected account sign-in. No retry was attempted.")


def lock_state(users, owner):
    """None means unavailable/ambiguous; a missing lock flag means unlocked."""
    if not isinstance(users, list):
        return None
    matches = [user for user in users if isinstance(user, dict)
               and type(user.get('kCGSSessionUserIDKey')) is int
               and user['kCGSSessionUserIDKey'] == owner
               and user.get('kCGSSessionOnConsoleKey') is True]
    if len(matches) != 1:
        return None
    value = matches[0].get('CGSSessionScreenIsLocked', False)
    return value if isinstance(value, bool) else None


def screen_locked():
    """Read only this operator's console, in memory, without child processes."""
    cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    io = ctypes.CDLL('/System/Library/Frameworks/IOKit.framework/IOKit')
    cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
    cf.CFStringCreateWithCString.restype = ctypes.c_void_p
    cf.CFPropertyListCreateData.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long,
                                          ctypes.c_ulong, ctypes.c_void_p]
    cf.CFPropertyListCreateData.restype = ctypes.c_void_p
    cf.CFDataGetLength.argtypes = [ctypes.c_void_p]
    cf.CFDataGetLength.restype = ctypes.c_long
    cf.CFDataGetBytePtr.argtypes = [ctypes.c_void_p]
    cf.CFDataGetBytePtr.restype = ctypes.c_void_p
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    cf.CFRelease.restype = None
    io.IORegistryGetRootEntry.argtypes = [ctypes.c_uint32]
    io.IORegistryGetRootEntry.restype = ctypes.c_uint32
    io.IORegistryEntryCreateCFProperty.argtypes = [ctypes.c_uint32, ctypes.c_void_p,
                                                  ctypes.c_void_p, ctypes.c_uint32]
    io.IORegistryEntryCreateCFProperty.restype = ctypes.c_void_p
    io.IOObjectRelease.argtypes = [ctypes.c_uint32]
    io.IOObjectRelease.restype = ctypes.c_int
    root = io.IORegistryGetRootEntry(0)
    if not root:
        return None
    key = users = data = None
    try:
        key = cf.CFStringCreateWithCString(None, b'IOConsoleUsers', 0x08000100)
        if not key:
            return None
        users = io.IORegistryEntryCreateCFProperty(root, key, None, 0)
        if not users:
            return None
        data = cf.CFPropertyListCreateData(None, users, 100, 0, None)
        if not data:
            return None
        length = cf.CFDataGetLength(data)
        pointer = cf.CFDataGetBytePtr(data)
        if not pointer or not 0 < length <= 262144:
            return None
        return lock_state(plistlib.loads(ctypes.string_at(pointer, length)), os.geteuid())
    finally:
        for value in (data, users, key):
            if value:
                cf.CFRelease(value)
        io.IOObjectRelease(root)


def main():
    username = password = bytearray()
    try:
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise ProbeError('Run this experiment in your own interactive Mac Terminal.')
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        username = bytearray(pwd.getpwuid(os.geteuid()).pw_name.encode('utf-8'))
        print('Native Screen Sharing account-auth experiment (one local attempt).')
        print('Using the current Terminal user. Close Kodex Desktop panes before continuing.')
        print('Enter your Mac account password only here; it is not saved or sent to Kodex.')
        print('This probe sends no keys, clicks, clipboard, framebuffer or display-configuration requests.')
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            password = bytearray(getpass.getpass('Mac login password: ').encode('utf-8'))
        if not 1 <= len(username) <= 63 or not 1 <= len(password) <= 63 or 0 in username or 0 in password:
            raise ProbeError('Username/password must be 1–63 UTF-8 bytes without NUL.')
        print('Lock the Mac now with Control-Command-Q. Waiting up to 60 seconds.')
        print('Unlock locally afterward if the experiment does not unlock it.')
        deadline = time.monotonic() + 60
        while True:
            locked = screen_locked()
            if locked is None:
                raise ProbeError('Could not identify your active console; no authentication was attempted.')
            if locked:
                break
            if time.monotonic() >= deadline:
                raise ProbeError('No locked console observed; no authentication was attempted.')
            time.sleep(0.25)
        if screen_locked() is not True:
            raise ProbeError('The console changed before connection; no authentication was attempted.')
        with socket.create_connection(('127.0.0.1', 5900), timeout=3) as peer:
            try:
                account_signin(peer, username, password)
            finally:
                password[:] = b'\0' * len(password)
            print('Apple account authentication accepted. Checking whether the existing console unlocks…')
            # Existing physical console, shared/enhanced; no virtual-session picker.
            # Delayed/missing ServerInit must not erase evidence of accepted authentication.
            try:
                peer.settimeout(3)
                peer.sendall(b'\x81')
            except OSError:
                print('Console initialization could not be sent; authentication was already accepted.')
            deadline = time.monotonic() + 10
            while screen_locked() is not False and time.monotonic() < deadline:
                time.sleep(0.25)
            unlocked = screen_locked() is False
        print('EXISTING CONSOLE UNLOCKED' if unlocked else 'AUTH ACCEPTED, CONSOLE STILL LOCKED OR UNKNOWN — unlock was not proven.')
        return 0 if unlocked else 2
    except (Exception, KeyboardInterrupt) as error:
        # Native server prose and exceptions containing credentials are never printed.
        print(str(error) if isinstance(error, ProbeError) else 'Native sign-in experiment failed; no automatic retry was attempted.')
        return 1
    finally:
        # Best effort only: Python/runtime immutable copies cannot be guaranteed erased.
        username[:] = b'\0' * len(username)
        password[:] = b'\0' * len(password)


if __name__ == '__main__':
    raise SystemExit(main())
