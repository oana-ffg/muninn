#!/usr/bin/env python3
"""Provider-neutral private photo relay. Python standard library only."""

import argparse
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

UUID = re.compile(
    r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z"
)
SHA = re.compile(r"[a-f0-9]{64}\Z")
MAX_SIZE = 8 * 1024 * 1024


class ClientError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ClientError(
            "Redirect refused. Check the configured Site origin and gateway access."
        )


def private_directory(path):
    path = Path(path).expanduser()
    if not path.is_absolute():
        raise ClientError("Cache directory must be absolute.")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or (os.name != "nt" and path.stat().st_mode & 0o077):
        raise ClientError(
            "Cache directory must be owner-private and must not be a symlink."
        )
    if any((p / ".git").exists() for p in (path, *path.parents)):
        raise ClientError("Photo cache must be outside Git repositories.")
    return path


def load_config(config_path):
    path = Path(config_path).expanduser()
    if (
        path.is_symlink()
        or not path.is_file()
        or (os.name != "nt" and path.stat().st_mode & 0o077)
    ):
        raise ClientError("Configuration must be an owner-private regular file.")
    config = json.loads(path.read_text())
    if not isinstance(config, dict):
        raise ClientError("Configuration must be a JSON object.")
    return config


def credential_bundle(config):
    command = config.get("credential_command")
    if (
        not isinstance(command, list)
        or not command
        or not all(isinstance(p, str) and p and "\x00" not in p for p in command)
    ):
        raise ClientError("Configure credential_command as a nonempty argument array.")
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ClientError(
            f"Credential provider failed: {type(error).__name__}. Check its executable and unlock state."
        ) from None
    # Provider output can contain credentials, including on stderr. Report status, never echo it.
    if result.returncode or not result.stdout.strip() or len(result.stdout) > 16384:
        raise ClientError(
            f"Credential provider failed (exit {result.returncode}, {len(result.stdout)} output bytes). Check the secret store locally."
        )
    try:
        bundle = json.loads(result.stdout)
    except (ValueError, UnicodeError):
        raise ClientError("Credential provider must return a JSON object.") from None
    if not isinstance(bundle, dict) or any(
        not isinstance(bundle.get(k), str) or not bundle[k]
        for k in ("origin", "gateway_token", "app_token")
    ):
        raise ClientError(
            "Credential bundle needs origin, gateway_token, and app_token."
        )
    url = urlsplit(bundle["origin"])
    if (
        url.scheme != "https"
        or not url.netloc
        or url.username
        or url.password
        or url.path
        or url.query
        or url.fragment
    ):
        raise ClientError(
            "Credential origin must be an HTTPS origin with no path, user info, query, or fragment."
        )
    if bundle["origin"] != config.get("origin"):
        raise ClientError(
            "Credential origin differs from the pinned configuration origin."
        )
    return bundle


class Client:
    def __init__(self, bundle, environment, thread):
        self.bundle, self.environment, self.thread = bundle, environment, thread
        self.opener = build_opener(NoRedirect())

    def delivery_token(self, session):
        message = json.dumps(
            [session, self.environment, self.thread], separators=(",", ":")
        ).encode()
        return hmac.new(
            self.bundle["app_token"].encode(), message, hashlib.sha256
        ).hexdigest()

    def request(self, method, path, data=None, session=None, binary=False):
        token = self.delivery_token(session) if session else self.bundle["app_token"]
        headers = {
            "OAI-Sites-Authorization": "Bearer " + self.bundle["gateway_token"],
            "Authorization": "Bearer " + token,
            "X-Muninn-Environment": self.environment,
            "X-Muninn-Thread": self.thread,
            "Accept": "image/jpeg" if binary else "application/json",
        }
        body = None if data is None else json.dumps(data).encode()
        if body is not None:
            headers["Content-Type"] = "application/json"
        try:
            with self.opener.open(
                Request(
                    self.bundle["origin"] + path,
                    data=body,
                    headers=headers,
                    method=method,
                ),
                timeout=30,
            ) as response:
                expected = "image/jpeg" if binary else "application/json"
                if response.headers.get_content_type() != expected:
                    raise ClientError(
                        "Unexpected response format. Check Site authentication and deployment."
                    )
                limit = MAX_SIZE if binary else 65536
                value = response.read(limit + 1)
                if len(value) > limit:
                    raise ClientError("Response exceeded the allowed size.")
                if binary:
                    return value
                try:
                    return json.loads(value)
                except (ValueError, UnicodeError):
                    raise ClientError("Site returned invalid JSON.") from None
        except HTTPError as error:
            # Never echo proxy bodies, URLs, or arbitrary server text.
            error.close()
            raise ClientError(
                f"Site returned HTTP {error.code}. Session or access may have expired; no new acknowledgement was sent."
            ) from None
        except (URLError, TimeoutError, OSError) as error:
            raise ClientError(
                f"Site connection failed ({type(error).__name__}). Retry the same session; delivery is resumable."
            ) from None

    def new(self, label):
        session = str(uuid.uuid4())
        result = self.request(
            "POST",
            "/api/sessions",
            {
                "id": session,
                "environment": self.environment,
                "thread": self.thread,
                "label": label,
                "delivery_hash": hashlib.sha256(
                    self.delivery_token(session).encode()
                ).hexdigest(),
            },
        )
        if (
            result.get("id") != session
            or result.get("url") != f"{self.bundle['origin']}/s/{session}"
        ):
            raise ClientError("Site returned a different session identity or origin.")
        return result

    def fetch(self, session, cache):
        path = "/api/sessions/" + session
        state = self.request("GET", path, session=session)
        if (
            state.get("id") != session
            or state.get("environment") != self.environment
            or state.get("thread") != self.thread
        ):
            raise ClientError("Session destination differs from this chat.")
        if state.get("state") == "open":
            if state.get("expires_at", 0) <= time.time():
                raise ClientError("Capture session expired. Create a new session.")
            return {"state": "open", "id": session}
        if state.get("state") not in ("done", "acknowledging", "delivered"):
            raise ClientError("Unexpected session state.")
        photos = state.get("photos")
        if not isinstance(photos, list) or not 1 <= len(photos) <= 20:
            raise ClientError("Session photo manifest is invalid.")
        directory = private_directory(private_directory(cache) / session)
        paths, seen = [], set()
        for photo in photos:
            if (
                not isinstance(photo, dict)
                or not UUID.fullmatch(photo.get("id", ""))
                or not SHA.fullmatch(photo.get("sha256", ""))
                or type(photo.get("size")) is not int
                or not 4 <= photo["size"] <= MAX_SIZE
                or photo["id"] in seen
            ):
                raise ClientError(
                    "Session contains an invalid or duplicate photo manifest entry."
                )
            seen.add(photo["id"])
            target = directory / (photo["id"] + ".jpg")
            if target.is_symlink():
                raise ClientError("Refusing a symlink in the photo cache.")
            if target.exists():
                content = target.read_bytes()
            elif state["state"] in ("acknowledging", "delivered"):
                raise ClientError(
                    "Session was acknowledged but a local photo is missing. Remote bytes have already been deleted."
                )
            else:
                content = self.request(
                    "GET", path + "/photos/" + photo["id"], session=session, binary=True
                )
            if (
                len(content) != photo["size"]
                or hashlib.sha256(content).hexdigest() != photo["sha256"]
            ):
                raise ClientError(
                    "Photo size/checksum verification failed. Remote bytes were not acknowledged."
                )
            if not target.exists():
                atomic_new(target, content)
            paths.append(str(target))
        # Persist the manifest and files before irreversible remote deletion.
        manifest = json.dumps(
            {
                "id": session,
                "environment": self.environment,
                "thread": self.thread,
                "photos": photos,
            },
            indent=2,
        ).encode()
        manifest_path = directory / "manifest.json"
        if not manifest_path.exists():
            atomic_new(manifest_path, manifest)
        if os.name != "nt":
            fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        result = self.request(
            "POST",
            path + "/ack",
            {"photos": [{"id": p["id"], "sha256": p["sha256"]} for p in photos]},
            session=session,
        )
        if result.get("state") != "delivered":
            raise ClientError(
                "Site did not confirm remote deletion. Retry this session."
            )
        verified = self.request("GET", path, session=session)
        if (
            verified.get("state") != "delivered"
            or verified.get("remote_deleted") is not True
        ):
            raise ClientError(
                "Remote deletion could not be independently verified. Local photos are saved; retry this session."
            )
        return {
            "state": "delivered",
            "id": session,
            "files": paths,
            "remote_deleted": True,
        }


def atomic_new(target, content):
    fd, temporary = tempfile.mkstemp(prefix=".download-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, target)
    finally:
        os.unlink(temporary)


def prune(cache, days):
    directory = private_directory(cache)
    cutoff = time.time() - days * 86400
    removed = 0
    # Delete only complete, verified relay directories with a closed set of filenames.
    for child in directory.iterdir():
        if not UUID.fullmatch(child.name) or child.is_symlink() or not child.is_dir():
            continue
        manifest = child / "manifest.json"
        if (
            manifest.is_symlink()
            or not manifest.is_file()
            or manifest.stat().st_mtime >= cutoff
        ):
            continue
        record = json.loads(manifest.read_text())
        names = {p["id"] + ".jpg" for p in record["photos"]}
        if record.get("id") != child.name or any(
            not UUID.fullmatch(p.get("id", "")) for p in record["photos"]
        ):
            raise ClientError(
                "Invalid local cleanup manifest. No files were removed from that directory."
            )
        if {p.name for p in child.iterdir()} != names | {"manifest.json"}:
            raise ClientError("Unknown files in photo cache. Cleanup needs inspection.")
        for filename in names:
            (child / filename).unlink()
        manifest.unlink()
        child.rmdir()
        removed += 1
    return {"removed_sessions": removed}


def maintain(client, cache, days):
    purged = 0
    for _ in range(100):
        result = client.request("POST", "/api/cleanup", {})
        purged += result["purged_sessions"]
        if not result["more"]:
            break
    else:
        raise ClientError(
            "Remote cleanup exceeded its batch limit; retention is incomplete."
        )
    return {"purged_sessions": purged, **prune(cache, days)}


def notify_retention_failure(config):
    command = config.get("alert_command")
    if (
        not isinstance(command, list)
        or not command
        or not all(isinstance(p, str) and p for p in command)
    ):
        raise ClientError(
            "Retention failed and no valid alert_command is configured. Inspect the scheduler run."
        )
    message = (
        "Muninn retention cleanup failed on "
        + config.get("maintenance_label", "this host")
        + ". Inspect its scheduler run; cleanup is incomplete."
    )
    try:
        result = subprocess.run(
            [*command, message], capture_output=True, timeout=45, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        raise ClientError(
            "Retention failed and its failure notification could not run. Inspect scheduler logs."
        ) from None
    if result.returncode:
        raise ClientError(
            "Retention failed and its failure notification also failed. Inspect scheduler logs."
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config", default=str(Path.home() / ".config/muninn/client.json")
    )
    parser.add_argument("--environment")
    parser.add_argument("--thread", default=os.environ.get("T3CODE_THREAD_ID"))
    sub = parser.add_subparsers(dest="command", required=True)
    new = sub.add_parser("new")
    new.add_argument("--label", required=True)
    for command in ("wait", "fetch"):
        p = sub.add_parser(command)
        p.add_argument("session")
        if command == "wait":
            p.add_argument("--timeout", type=int, default=1800)
    sub.add_parser("cleanup")
    maintenance = sub.add_parser("maintain")
    maintenance.add_argument("--days", type=int, default=7)
    prune_parser = sub.add_parser("prune")
    prune_parser.add_argument("--days", type=int, default=7)
    args = parser.parse_args()
    config = load_config(args.config)
    try:
        run(args, config)
    except Exception:
        if args.command == "maintain":
            notify_retention_failure(config)
        raise


def run(args, config):
    bundle = credential_bundle(config)
    environment = args.environment or config.get("environment")
    if not environment or not args.thread:
        raise ClientError("Environment and current T3 thread are required.")
    client = Client(bundle, environment, args.thread)
    cache = config.get("cache_directory")
    if not cache:
        raise ClientError("Configure an absolute cache_directory outside Git.")
    if args.command == "new":
        result = client.new(args.label)
    elif args.command in ("fetch", "wait"):
        if not UUID.fullmatch(args.session):
            raise ClientError("Invalid session ID.")
        timeout = getattr(args, "timeout", 0)
        if not 0 <= timeout <= 86400:
            raise ClientError("Timeout must be between 0 and 86400 seconds.")
        deadline = time.monotonic() + timeout
        while True:
            result = client.fetch(args.session, cache)
            if result["state"] != "open" or args.command == "fetch":
                break
            if time.monotonic() >= deadline:
                raise ClientError(
                    "Timed out waiting for Done. Fetch the same session to resume."
                )
            time.sleep(min(2, max(0, deadline - time.monotonic())))
    elif args.command == "maintain":
        if args.days < 1:
            raise ClientError("Retention must be at least one day.")
        result = maintain(client, cache, args.days)
    elif args.command == "cleanup":
        result = client.request("POST", "/api/cleanup", {})
    else:
        if args.days < 1:
            raise ClientError("Retention must be at least one day.")
        result = prune(cache, args.days)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (ClientError, OSError, ValueError, KeyError) as error:
        # Do not stringify configuration/JSON exceptions: they may include secrets.
        message = (
            str(error)
            if isinstance(error, ClientError)
            else f"{type(error).__name__}: local configuration, cache, or filesystem operation failed."
        )
        print(json.dumps({"error": message}), file=sys.stderr)
        sys.exit(1)
