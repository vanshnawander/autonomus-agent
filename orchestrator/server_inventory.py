"""Validate a private server inventory and run policy-bounded SSH experiments.

Passwords are read internally and passed to ``sshpass`` through a pipe. They are
never printed, placed in the SSH command line, or returned by inspection APIs.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
_FORBIDDEN = re.compile(
    r"(?:^|\s)(?:sudo|su|shutdown|reboot|mkfs|mount|umount|docker\s+system\s+prune|"
    r"git\s+push|rm\s+-[A-Za-z]*r|rm\s+-[A-Za-z]*f)(?:\s|$)|(?:^|\s)(?:dd)(?:\s|$)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Server:
    name: str
    host: str
    user: str
    server_type: str
    port: int
    password: str | None
    identity_file: str | None
    workdir: str
    max_runtime_minutes: int
    allowed_command_prefixes: tuple[str, ...]
    notes: str
    enabled: bool


def _expect_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value.strip()


def load_inventory(path: Path) -> dict[str, Server]:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise ValueError(f"server inventory not found: {resolved}")
    if resolved.stat().st_mode & 0o777 != 0o600:
        raise ValueError("server inventory must have permissions 0600 (not group/world accessible)")
    try:
        raw = json.loads(resolved.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"server inventory is not valid JSON: {exc}") from exc
    except OSError as exc:
        raise ValueError(f"server inventory cannot be read: {exc}") from exc
    records = raw.get("servers") if isinstance(raw, dict) else None
    if not isinstance(records, list) or not records:
        raise ValueError("server inventory must contain a non-empty 'servers' array")
    servers: dict[str, Server] = {}
    for index, item in enumerate(records):
        if not isinstance(item, dict):
            raise ValueError(f"servers[{index}] must be an object")
        name = _expect_text(item.get("name"), f"servers[{index}].name")
        if not _NAME_RE.fullmatch(name) or name in servers:
            raise ValueError(f"invalid or duplicate server name: {name!r}")
        restrictions = item.get("restrictions") or {}
        if not isinstance(restrictions, dict):
            raise ValueError(f"servers[{index}].restrictions must be an object")
        prefixes = restrictions.get("allowed_command_prefixes") or []
        if not isinstance(prefixes, list) or not prefixes or not all(isinstance(v, str) and v.strip() for v in prefixes):
            raise ValueError(f"servers[{index}] requires non-empty allowed_command_prefixes")
        password = item.get("password")
        for prefix in prefixes:
            try:
                prefix_argv = tuple(shlex.split(prefix))
            except ValueError as exc:
                raise ValueError(f"invalid allowed command prefix: {prefix!r}") from exc
            executable = Path(prefix_argv[0]).name if prefix_argv else ""
            is_python = re.fullmatch(r"python(?:\d+(?:\.\d+)*)?", executable)
            unsafe = (
                not prefix_argv or not executable
                or executable in {"bash", "sh", "zsh", "dash", "env", "node", "perl", "ruby"}
                or (is_python and (
                    len(prefix_argv) < 2
                    or (prefix_argv[1].startswith("-") and not (
                        prefix_argv[1] == "-m" and len(prefix_argv) >= 3
                        and not prefix_argv[2].startswith("-")
                    ))
                ))
            )
            if unsafe:
                raise ValueError(f"allowed command prefix is too broad: {prefix!r}")
            if re.search(r"[;&|`$<>]", prefix):
                raise ValueError(f"allowed command prefix contains shell syntax: {prefix!r}")
        identity = item.get("identity_file")
        if not password and not identity:
            raise ValueError(f"server {name!r} requires password or identity_file")
        if password is not None and (
            not isinstance(password, str) or not password
            or any(c in password for c in ("\n", "\r", "\0"))
            or len(password.encode("utf-8")) > 1024
        ):
            raise ValueError("password must be a non-empty single-line string of at most 1024 bytes")
        if type(item.get("enabled", True)) is not bool:
            raise ValueError("enabled must be a JSON boolean")
        if type(item.get("port", 22)) is not int:
            raise ValueError("port must be an integer")
        port = item.get("port", 22)
        if not 1 <= port <= 65535:
            raise ValueError(f"server {name!r} has invalid port")
        identity_path = Path(str(identity)).expanduser().resolve() if identity else None
        if identity_path is not None:
            if not identity_path.is_file():
                raise ValueError(f"identity file for server {name!r} does not exist")
            if identity_path.stat().st_mode & 0o077:
                raise ValueError(f"identity file for server {name!r} must have permissions 0600")
        workdir = _expect_text(restrictions.get("workdir"), f"servers[{index}].restrictions.workdir")
        if not workdir.startswith("/") or ".." in Path(workdir).parts:
            raise ValueError(f"server {name!r} requires an absolute, traversal-free workdir")
        if type(restrictions.get("max_runtime_minutes", 60)) is not int:
            raise ValueError("max_runtime_minutes must be an integer")
        max_runtime = restrictions.get("max_runtime_minutes", 60)
        if not 1 <= max_runtime <= 1440:
            raise ValueError(f"server {name!r} max_runtime_minutes must be between 1 and 1440")

        host = _expect_text(item.get("host"), "host")
        user = _expect_text(item.get("user"), "user")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.:%_-]*", host):
            raise ValueError("invalid SSH host")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", user):
            raise ValueError("invalid SSH user")
        servers[name] = Server(
            name=name,
            host=host,
            user=user,
            server_type=_expect_text(item.get("type"), f"servers[{index}].type"),
            port=port,
            password=str(password) if password else None,
            identity_file=str(identity_path) if identity_path else None,
            workdir=workdir,
            max_runtime_minutes=max_runtime,
            allowed_command_prefixes=tuple(v.strip() for v in prefixes),
            notes=str(restrictions.get("notes", "")),
            enabled=bool(item.get("enabled", True)),
        )
    return servers


def redacted_inventory(path: Path) -> list[dict[str, Any]]:
    return [
        {
            "name": server.name,
            "host": server.host,
            "user": server.user,
            "type": server.server_type,
            "port": server.port,
            "auth": "identity_file" if server.identity_file else "password",
            "workdir": server.workdir,
            "max_runtime_minutes": server.max_runtime_minutes,
            "allowed_command_prefixes": list(server.allowed_command_prefixes),
            "notes": server.notes,
            "enabled": server.enabled,
        }
        for server in load_inventory(path).values()
    ]


def _validate_remote_command(server: Server, command: list[str]) -> str:
    if not command:
        raise ValueError("a remote command is required after --")
    joined = shlex.join(command)
    if not server.enabled:
        raise ValueError(f"server {server.name!r} is disabled")
    if _FORBIDDEN.search(joined) or "\n" in joined or "\r" in joined:
        raise ValueError("remote command violates the immutable safety policy")
    allowed = False
    for prefix in server.allowed_command_prefixes:
        try:
            prefix_argv = shlex.split(prefix)
        except ValueError as exc:
            raise ValueError(f"invalid allowed command prefix: {prefix!r}") from exc
        if command[: len(prefix_argv)] == prefix_argv:
            allowed = True
            break
    if not allowed:
        raise ValueError("remote command is not permitted by allowed_command_prefixes")
    return joined


def run_remote(path: Path, server_name: str, command: list[str]) -> int:
    servers = load_inventory(path)
    if server_name not in servers:
        raise ValueError(f"unknown server: {server_name!r}")
    server = servers[server_name]
    remote = _validate_remote_command(server, command)
    ssh = [
        "ssh", "-T", "-p", str(server.port), "-o",
        "BatchMode=yes" if server.identity_file else "BatchMode=no",
        "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15",
    ]
    pass_read: int | None = None
    pass_write: int | None = None
    if server.identity_file:
        ssh += ["-i", server.identity_file]
    elif server.password is not None:
        sshpass = shutil.which("sshpass")
        if not sshpass:
            raise RuntimeError("password authentication requires sshpass; prefer an SSH key")
        pass_read, pass_write = os.pipe()
        ssh = [sshpass, "-d", str(pass_read), *ssh]
    # GNU timeout runs on the server, so an SSH disconnect cannot remove the
    # runtime deadline. It also signals the command's process group.
    timeout_seconds = server.max_runtime_minutes * 60
    remote_script = (
        f"cd {shlex.quote(server.workdir)} && exec timeout --signal=TERM "
        f"--kill-after=10s {timeout_seconds}s {remote}"
    )
    ssh += [f"{server.user}@{server.host}", remote_script]
    timeout_seconds = server.max_runtime_minutes * 60
    proc: subprocess.Popen[bytes] | None = None
    try:
        proc = subprocess.Popen(ssh, pass_fds=(() if pass_read is None else (pass_read,)))
        if pass_read is not None and pass_write is not None:
            os.close(pass_read)
            pass_read = None
            os.write(pass_write, (server.password or "").encode("utf-8") + b"\n")
            os.close(pass_write)
            pass_write = None
        return proc.wait(timeout=timeout_seconds + 45)
    except subprocess.TimeoutExpired:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        print(f"remote command exceeded {server.max_runtime_minutes} minute limit", file=sys.stderr)
        return 124
    finally:
        for fd in (pass_read, pass_write):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Inspect or use the private experiment server inventory")
    parser.add_argument("--file", default=os.environ.get("DEVIN_ORCH_SERVERS_FILE", "servers.json"))
    subparsers = parser.add_subparsers(dest="action", required=True)
    subparsers.add_parser("inspect", help="print redacted server capabilities")
    run_parser = subparsers.add_parser("run", help="run one policy-bounded SSH command")
    run_parser.add_argument("server")
    run_parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    path = Path(args.file)
    try:
        if args.action == "inspect":
            print(json.dumps({"servers": redacted_inventory(path)}, indent=2))
            return 0
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        return run_remote(path, args.server, command)
    except Exception as exc:
        print(f"server inventory error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
