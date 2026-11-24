#!/usr/bin/env python3
"""Windows Credential Manager provider for Muninn. Python standard library only."""

import argparse
import ctypes
import json
import os
import sys
from urllib.parse import urlsplit

DEFAULT_TARGET = "Muninn.PhotoRelay"
DEFAULT_USERNAME = "Muninn Photo Relay"
CRED_TYPE_GENERIC = 1
CRED_PERSIST_LOCAL_MACHINE = 2
CRED_MAX_CREDENTIAL_BLOB_SIZE = 2560
MAX_INPUT_BYTES = 16384
ERROR_NOT_FOUND = 1168
ERROR_NO_SUCH_LOGON_SESSION = 1312
REQUIRED_KEYS = ("origin", "gateway_token", "app_token")


class ProviderError(Exception):
    pass


def validate_origin(origin):
    if not isinstance(origin, str) or not origin:
        raise ProviderError("Credential bundle needs a valid HTTPS origin.")
    url = urlsplit(origin)
    if (
        url.scheme != "https"
        or not url.netloc
        or url.username
        or url.password
        or url.path
        or url.query
        or url.fragment
    ):
        raise ProviderError(
            "Credential origin must be an HTTPS origin with no path, user info, query, or fragment."
        )
    return origin


def validate_bundle(raw_bytes):
    if not isinstance(raw_bytes, (bytes, bytearray)) or not raw_bytes.strip():
        raise ProviderError("Credential bundle is empty.")
    if len(raw_bytes) > MAX_INPUT_BYTES:
        raise ProviderError("Credential bundle exceeds the allowed size.")
    try:
        bundle = json.loads(raw_bytes.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise ProviderError("Credential bundle must be valid UTF-8 JSON.") from None
    if not isinstance(bundle, dict) or any(
        not isinstance(bundle.get(k), str) or not bundle[k] for k in REQUIRED_KEYS
    ):
        raise ProviderError(
            "Credential bundle needs origin, gateway_token, and app_token."
        )
    origin = validate_origin(bundle["origin"])
    normalized = json.dumps(
        {k: bundle[k] for k in REQUIRED_KEYS}, separators=(",", ":")
    ).encode("utf-8")
    return normalized, origin


def encode_utf16le(payload_utf8):
    try:
        blob = payload_utf8.decode("utf-8").encode("utf-16-le")
    except UnicodeError:
        raise ProviderError("Credential bundle must be valid UTF-8.") from None
    if not blob or len(blob) > CRED_MAX_CREDENTIAL_BLOB_SIZE:
        raise ProviderError(
            "Credential bundle exceeds the Windows Credential Manager size limit."
        )
    return blob


def decode_utf16le(blob):
    if not blob or len(blob) > CRED_MAX_CREDENTIAL_BLOB_SIZE or len(blob) % 2:
        raise ProviderError("Stored Windows credential blob has an invalid size.")
    try:
        return blob.decode("utf-16-le").encode("utf-8")
    except UnicodeError:
        raise ProviderError("Stored Windows credential is not valid UTF-16LE.") from None


def _win32_error_message(action, target, error_code):
    if error_code == ERROR_NOT_FOUND:
        return f"Windows Credential Manager entry '{target}' was not found."
    if error_code == ERROR_NO_SUCH_LOGON_SESSION:
        return (
            f"Windows Credential Manager {action} is unavailable in this logon session "
            "(Win32 error 1312). Run in an interactive desktop session outside restricted sandboxes."
        )
    return f"Windows Credential Manager {action} failed (Win32 error {error_code})."


class WinCredBackend:
    """ctypes wrapper over Advapi32 CredReadW / CredWriteW / CredFree."""

    def __init__(self):
        if os.name != "nt":
            raise ProviderError("Windows Credential Manager is only supported on Windows.")

        class FILETIME(ctypes.Structure):
            _fields_ = [
                ("dwLowDateTime", ctypes.c_uint32),
                ("dwHighDateTime", ctypes.c_uint32),
            ]

        class CREDENTIALW(ctypes.Structure):
            _fields_ = [
                ("Flags", ctypes.c_uint32),
                ("Type", ctypes.c_uint32),
                ("TargetName", ctypes.c_wchar_p),
                ("Comment", ctypes.c_wchar_p),
                ("LastWritten", FILETIME),
                ("CredentialBlobSize", ctypes.c_uint32),
                ("CredentialBlob", ctypes.c_void_p),
                ("Persist", ctypes.c_uint32),
                ("AttributeCount", ctypes.c_uint32),
                ("Attributes", ctypes.c_void_p),
                ("TargetAlias", ctypes.c_wchar_p),
                ("UserName", ctypes.c_wchar_p),
            ]

        self._cred_type = CREDENTIALW
        self._cred_ptr_type = ctypes.POINTER(CREDENTIALW)
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

        advapi32.CredReadW.argtypes = [
            ctypes.c_wchar_p,
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.POINTER(self._cred_ptr_type),
        ]
        advapi32.CredReadW.restype = ctypes.c_int

        advapi32.CredWriteW.argtypes = [self._cred_ptr_type, ctypes.c_uint32]
        advapi32.CredWriteW.restype = ctypes.c_int

        advapi32.CredFree.argtypes = [ctypes.c_void_p]
        advapi32.CredFree.restype = None

        self._advapi32 = advapi32

    def read(self, target):
        cred_ptr = self._cred_ptr_type()
        if not self._advapi32.CredReadW(
            target, CRED_TYPE_GENERIC, 0, ctypes.byref(cred_ptr)
        ):
            raise ProviderError(
                _win32_error_message("read", target, ctypes.get_last_error())
            )
        try:
            cred = cred_ptr.contents
            size = int(cred.CredentialBlobSize)
            if size <= 0 or size > CRED_MAX_CREDENTIAL_BLOB_SIZE or size % 2:
                raise ProviderError(
                    "Stored Windows credential blob has an invalid size."
                )
            if not cred.CredentialBlob:
                raise ProviderError("Stored Windows credential blob pointer is null.")
            buf = ctypes.create_string_buffer(size)
            try:
                ctypes.memmove(buf, cred.CredentialBlob, size)
                return decode_utf16le(buf.raw)
            finally:
                ctypes.memset(buf, 0, size)
        finally:
            self._advapi32.CredFree(cred_ptr)

    def write(self, target, username, payload_utf8):
        blob = encode_utf16le(payload_utf8)
        buf = ctypes.create_string_buffer(blob, len(blob))
        try:
            cred = self._cred_type()
            cred.Flags = 0
            cred.Type = CRED_TYPE_GENERIC
            cred.TargetName = target
            cred.Comment = "Muninn private photo relay credentials"
            cred.CredentialBlobSize = len(blob)
            cred.CredentialBlob = ctypes.cast(buf, ctypes.c_void_p)
            cred.Persist = CRED_PERSIST_LOCAL_MACHINE
            cred.AttributeCount = 0
            cred.Attributes = None
            cred.TargetAlias = None
            cred.UserName = username
            if not self._advapi32.CredWriteW(ctypes.byref(cred), 0):
                raise ProviderError(
                    _win32_error_message("write", target, ctypes.get_last_error())
                )
        finally:
            ctypes.memset(buf, 0, len(blob))


def run(args, backend=None, stdin_stream=None, stdout_stream=None):
    store = backend if backend is not None else WinCredBackend()
    out = stdout_stream if stdout_stream is not None else sys.stdout.buffer
    inp = stdin_stream if stdin_stream is not None else sys.stdin.buffer

    if not args.target or "\x00" in args.target:
        raise ProviderError("Credential target name must be a non-empty string.")

    if args.command == "get":
        normalized, _ = validate_bundle(store.read(args.target))
        out.write(normalized)
        out.flush()
    elif args.command == "check":
        _, origin = validate_bundle(store.read(args.target))
        out.write(
            json.dumps(
                {"configured": True, "target": args.target, "origin": origin}
            ).encode("utf-8")
            + b"\n"
        )
        out.flush()
    elif args.command == "set":
        if not args.username or "\x00" in args.username:
            raise ProviderError("Credential username must be a non-empty string.")
        raw = inp.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise ProviderError("Credential input exceeded the allowed size.")
        normalized, origin = validate_bundle(raw)
        store.write(args.target, args.username, normalized)
        out.write(
            json.dumps(
                {"status": "stored", "target": args.target, "origin": origin}
            ).encode("utf-8")
            + b"\n"
        )
        out.flush()
    else:
        raise ProviderError(f"Unknown command: {args.command}")


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default=DEFAULT_TARGET)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("get", help="Write the stored JSON credential bundle to stdout.")
    sub.add_parser("check", help="Verify the stored credential without printing secrets.")
    set_parser = sub.add_parser(
        "set", help="Read a JSON credential bundle from stdin and store it."
    )
    set_parser.add_argument("--username", default=DEFAULT_USERNAME)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    run(args)


if __name__ == "__main__":
    try:
        main()
    except (ProviderError, OSError, ValueError) as error:
        message = (
            str(error)
            if isinstance(error, ProviderError)
            else f"{type(error).__name__}: Windows Credential Manager operation failed."
        )
        if sys.stderr is not None:
            print(json.dumps({"error": message}), file=sys.stderr)
        sys.exit(1)
