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
import zlib


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
            raise ProbeError("Native protocol timed out.")
        peer.settimeout(remaining)
        block = peer.recv(length - len(result))
        if not block:
            raise ProbeError("Screen Sharing closed the protocol connection.")
        result.extend(block)
    return result


def send_bounded(peer, data, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProbeError('Native protocol timed out.')
    peer.settimeout(remaining)
    peer.sendall(data)


def account_signin(peer, username, password):
    """Authenticate only; acceptance does not prove console initialization/unlock."""
    if (not 1 <= len(username) <= 63 or not 1 <= len(password) <= 63
            or 0 in username or 0 in password):
        raise ProbeError("ARD requires username/password of 1–63 UTF-8 bytes without NUL; nothing was sent.")
    deadline = time.monotonic() + 8
    version = read_exact(peer, 12, deadline)
    if version != b'RFB 003.889\n':
        raise ProbeError("Unsupported Screen Sharing protocol.")
    send_bounded(peer, version, deadline)
    count = read_exact(peer, 1, deadline)[0]
    if not count or 30 not in read_exact(peer, count, deadline):
        raise ProbeError("Screen Sharing did not offer Apple account authentication; no fallback was attempted.")
    send_bounded(peer, b'\x1e', deadline)
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
        send_bounded(peer, encrypted + public, deadline)
    finally:
        for buffer in (credentials, key, shared, encrypted):
            if buffer is not None:
                buffer[:] = b'\0' * len(buffer)
    if struct.unpack('>I', read_exact(peer, 4, deadline))[0] != 0:
        raise ProbeError("The Mac rejected account sign-in. No retry was attempted.")


def session_body(peer, minimum, deadline):
    size, = struct.unpack('>H', read_exact(peer, 2, deadline))
    if not minimum <= size <= 4096:
        raise ProbeError('Invalid native session packet size.')
    body = read_exact(peer, size, deadline)
    if body[:2] != b'\0\1':
        raise ProbeError('Unsupported native session version.')
    return body


def initialize_console(peer, username):
    """Initialize shared access; select the own console only when a picker is offered.

    Framing reference: peetinc/noVNC-ARD ard/ard-patch.js,
    d699293635083c9e0c30c8f9480993865653772a (MPL-2.0).
    This is reverse-engineered behavior, not a public Apple API.
    """
    if not 1 <= len(username) <= 63 or 0 in username:
        raise ProbeError('Invalid console username.')
    deadline = time.monotonic() + 10
    send_bounded(peer, b'\xc1', deadline)  # Shared + session select + enhanced.
    header = read_exact(peer, 24, deadline)
    width, height = struct.unpack_from('>HH', header)
    size, = struct.unpack_from('>I', header, 20)
    if size > 65536:
        raise ProbeError('Oversized ServerInit.')
    name = read_exact(peer, size, deadline)
    flags = 0
    if name and name[0] == 0:
        if len(name) < 22:
            raise ProbeError('Truncated extended ServerInit.')
        flags, = struct.unpack_from('>I', name, 2)
    if not (flags & 4):
        # Apple's picker is optional. Do not wait for SessionInfo or invent a command.
        # Normal shared setup follows; this does not identify/prove an unlocked console.
        return width, height, False
    info = session_body(peer, 11, deadline)
    allowed, = struct.unpack_from('>I', info, 2)
    console = info[10:]
    if 0 not in console or console.split(b'\0', 1)[0] != username or not (allowed & 2):
        raise ProbeError('Own existing console was not offered; no session command was sent.')
    command = struct.pack('>HHIBB', 72, 1, 0, 1, 0) + username + bytes(64 - len(username))
    send_bounded(peer, command, deadline)  # ConnectToConsole=1, never RequestConsole/Virtual.
    for _ in range(32):
        result = session_body(peer, 6, deadline)
        status, = struct.unpack_from('>I', result, 2)
        if status in (0, 4):
            return width, height, True
        if status not in (2, 3):
            raise ProbeError('Existing-console selection was not granted.')
    raise ProbeError('Existing-console selection remained pending; no retry was attempted.')


def display_size(peer, deadline, desired=None):
    size, = struct.unpack('>H', read_exact(peer, 2, deadline))
    if not 20 <= size <= 4096:
        raise ProbeError('Invalid native display metadata size.')
    body = read_exact(peer, size, deadline)
    version, = struct.unpack_from('>H', body)
    count, = struct.unpack_from('>H', body, 18)
    if version != 5 or count > 32 or size != 20 + count * 56:
        raise ProbeError('Unsupported native display metadata.')
    main = []
    ids = set()
    for index in range(count):
        offset = 20 + index * 56
        display, = struct.unpack_from('>I', body, offset + 16)
        flags, = struct.unpack_from('>I', body, offset + 36)
        if display == 0xffffffff or display in ids:
            raise ProbeError('Invalid native display identity.')
        ids.add(display)
        if flags & 1:
            main.append(display)
    if len(main) != 1:
        raise ProbeError('No unambiguous native main monitor was offered.')
    selected, = struct.unpack_from('>I', body, 10)
    if selected != main[0]:
        # Changes only this connection's streamed monitor, never macOS display modes.
        if desired != main[0]:
            send_bounded(peer, struct.pack('>BBBBI', 13, 0, 0, 0, main[0]), deadline)
        return 0, 0, main[0], False
    width, height = struct.unpack_from('>HH', body, 6)
    return width, height, main[0], True


def check_pixels(peer, width, height):
    """Read/discard one bounded pixel sample; this does not prove unlock.

    No host input, clipboard, session encryption or physical display changes.
    Unsupported protocol data is inconclusive instead of guessed or logged.
    """
    deadline = time.monotonic() + 10
    bitmap = bytearray(32)
    for index, value in ((0, 0xb0), (2, 0x0c), (3, 3), (4, 0x90), (10, 0x40)):
        bitmap[index] = value
    viewer = struct.pack('>BBHHI6I', 33, 0, 62, 1, 2, 6, 1, 0, 15, 0, 0) + bitmap
    encodings = [6, 0, 1105, -223, -224]  # Zlib, Raw, native metadata, size, LastRect.
    formats = struct.pack('>BBH', 2, 0, len(encodings))
    formats += b''.join(struct.pack('>i', encoding) for encoding in encodings)
    pixel_format = bytes(4) + struct.pack('>BBBBHHHBBB3x', 32, 24, 0, 1, 255, 255, 255, 16, 8, 0)
    send_bounded(peer, viewer + b'\x0a\0\0\1' + b'\x0d\1' + bytes(6)
                 + formats + pixel_format + formats, deadline)
    requested = False
    desired = None
    selection_ready = True  # Initial ServerInit may already deliver a standard framebuffer.
    inflater = zlib.decompressobj()
    rectangles = 0
    for _ in range(128):
        if not requested and selection_ready and width > 0 and height > 0:
            w, h = min(width, 64), min(height, 64)
            request = struct.pack('>BBHHHH', 3, 0, 0, 0, w, h)
            subscription = struct.pack('>BBHIHHHH', 9, 0, 1, 0, 0, 0, w, h)
            send_bounded(peer, request + subscription, deadline)
            requested = True
        kind = read_exact(peer, 1, deadline)[0]
        if kind in (2, 4, 7):  # Bell, Apple Ack/NOP; no payload.
            continue
        if kind == 20:  # StateChange: pad, u16 size, opaque payload.
            header = read_exact(peer, 3, deadline)
            size, = struct.unpack_from('>H', header, 1)
            if not 4 <= size <= 4096:
                raise ProbeError('Invalid native state-change size.')
            read_exact(peer, size, deadline)
            continue
        if kind == 81:  # Standalone DisplayInfo2.
            before = (width, height)
            width, height, desired, selection_ready = display_size(peer, deadline, desired)
            if not selection_ready or before != (width, height):
                requested = False
            continue
        if kind != 0:
            raise ProbeError(f'Unsupported native message type {kind}; pixel delivery is inconclusive.')
        header = read_exact(peer, 3, deadline)
        count, = struct.unpack_from('>H', header, 1)
        # LastRect permits count=65535; bound actual rectangles, not the sentinel.
        for _ in range(count):
            rectangles += 1
            if rectangles > 1024:
                raise ProbeError('Native rectangle limit exceeded.')
            x, y, w, h, encoding = struct.unpack('>HHHHi', read_exact(peer, 12, deadline))
            if encoding == -224:
                break
            if encoding == -223:
                if selection_ready:
                    requested = requested and (width, height) == (w, h)
                    width, height = w, h
            elif encoding == 1105:
                before = (width, height)
                width, height, desired, selection_ready = display_size(peer, deadline, desired)
                if not selection_ready or before != (width, height):
                    requested = False
            elif encoding in (0, 6):
                size = w * h * 4
                if not 0 < size <= 8 * 1024 * 1024:
                    raise ProbeError('Invalid or oversized native pixel sample.')
                if encoding == 6:
                    length, = struct.unpack('>I', read_exact(peer, 4, deadline))
                    if not 0 < length <= 8 * 1024 * 1024:
                        raise ProbeError('Invalid compressed pixel sample size.')
                    compressed = read_exact(peer, length, deadline)
                    decoded = inflater.decompress(compressed, size + 1)
                    if len(decoded) != size:
                        raise ProbeError('Incomplete or oversized decoded pixel sample.')
                    del decoded
                else:
                    while size:
                        block = read_exact(peer, min(size, 4096), deadline)
                        size -= len(block)
                        block[:] = bytes(len(block))
                if selection_ready and width > 0 and height > 0:
                    return
            else:
                raise ProbeError(f'Unsupported native encoding {encoding}; pixel delivery is inconclusive.')
    raise ProbeError('No pixel sample arrived within the native message limit.')


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
        print('This selects your existing console and checks a small pixel sample, without saving it.')
        print('It sends no keys, clicks or clipboard and does not change physical display configuration.')
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            password = bytearray(getpass.getpass('Mac login password: ').encode('utf-8'))
        if not 1 <= len(username) <= 63 or not 1 <= len(password) <= 63 or 0 in username or 0 in password:
            raise ProbeError('Username/password must be 1–63 UTF-8 bytes without NUL.')
        print('Lock the Mac now with Control-Command-Q. Waiting up to 60 seconds.')
        print('If it stays locked, wait at least 60 seconds before unlocking locally.')
        print('Unlocking locally while this probe runs invalidates its unlock result.')
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
            print('APPLE ACCOUNT AUTHENTICATION ACCEPTED')
            phase = 'console initialization'
            try:
                width, height, selected = initialize_console(peer, username)
                print('EXISTING OWN CONSOLE GRANTED' if selected
                      else 'NO SESSION PICKER — continuing normal shared viewer setup.')
                phase = 'viewer setup/pixel delivery'
                check_pixels(peer, width, height)
                print('PIXEL SAMPLE RECEIVED AND DISCARDED — this alone does not prove unlock.')
            except Exception as error:
                if isinstance(error, (TimeoutError, socket.timeout)):
                    detail = f'Timed out during {phase}'
                elif isinstance(error, ProbeError):
                    detail = f'{phase}: {error}'
                else:
                    detail = f'{phase} did not complete'
                print(f'{detail}; authentication was accepted.')
            print('Checking whether the existing console unlocks…')
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
