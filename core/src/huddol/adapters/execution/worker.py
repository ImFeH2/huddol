from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
from dataclasses import asdict
from typing import Any

from huddol.adapters.execution.editing import edit_file
from huddol.adapters.execution.local import LocalExecution
from huddol.core.errors import DomainError


def result_value(output: bytes) -> dict[str, Any]:
    try:
        frame = json.loads(output.decode("utf-8"))
        if not isinstance(frame, dict):
            raise TypeError
        if "error" in frame:
            error = frame["error"]
            raise DomainError(str(error["code"]), str(error["message"]))
        result = frame["result"]
        if not isinstance(result, dict):
            raise TypeError
        return result
    except (ValueError, KeyError, TypeError) as error:
        raise DomainError("execution_protocol", "Invalid execution response") from error


def _reply(operation: Any) -> None:
    try:
        frame = {"result": operation()}
    except DomainError as error:
        frame = {"error": {"code": error.code, "message": str(error)}}
    except (OSError, ValueError, TypeError, KeyError) as error:
        frame = {"error": {"code": "execution_failed", "message": str(error)}}
    sys.stdout.buffer.write(
        json.dumps(frame, ensure_ascii=False).encode("utf-8") + b"\n"
    )
    sys.stdout.buffer.flush()


def host_path(value: str) -> str:
    if not isinstance(value, str):
        raise DomainError("invalid_path", "Paths must be strings")
    if re.match(r"^[A-Za-z]:[\\/]", value) or value.startswith("\\\\"):
        translated = subprocess.run(
            ["wslpath", "-u", value], capture_output=True, timeout=10, check=False
        )
        if translated.returncode:
            raise DomainError("invalid_path", "Cannot resolve host path in WSL")
        return translated.stdout.decode("utf-8").strip()
    return value


def edit_main() -> int:
    _reply(
        lambda: asdict(edit_file(**json.loads(sys.stdin.buffer.read().decode("utf-8"))))
    )
    return 0


def auxiliary_main(args: list[str]) -> int:
    if args == ["--execution-edit"]:
        return edit_main()
    if args and args[0] == "--windows-write-sandbox" and os.name == "nt":
        from huddol.adapters.sandbox.windows import run_restricted_command

        separator = args.index("--")
        return run_restricted_command(args[1], args[separator + 1 :], os.getcwd())
    raise SystemExit("Unknown execution mode")


def main() -> int:
    if sys.argv[1:]:
        return auxiliary_main(sys.argv[1:])
    if not sys.platform.startswith("linux"):
        raise SystemExit("The execution worker requires Linux")
    environment: LocalExecution | None = None

    def execute() -> dict[str, Any]:
        nonlocal environment
        request = json.loads(sys.stdin.buffer.readline().decode("utf-8"))
        if not isinstance(request, dict) or request.get("operation") not in {
            "inspect",
            "run",
            "edit",
        }:
            raise DomainError("invalid_operation", "Unknown execution operation")
        environment = LocalExecution(
            host_path(request["root"]),
            [host_path(item) for item in request["directories"]],
            tolerant=bool(request.get("tolerant", False)),
        )

        def disconnected() -> None:
            while os.read(sys.stdin.fileno(), 4096):
                pass
            if environment is not None:
                environment.close()
            os._exit(1)

        threading.Thread(target=disconnected, daemon=True).start()
        operation = request["operation"]
        if operation == "inspect":
            probe = environment.run(["/bin/true"], timeout=10)
            if probe.exit_code:
                raise DomainError(
                    "sandbox_unavailable",
                    "Linux filesystem write protection is unavailable",
                )
            return {
                "root": environment.root,
                "write_directories": list(environment.write_directories),
                "skipped": list(environment.skipped),
                "description": environment.describe_environment(),
            }
        params = request.get("params", {})
        if not isinstance(params, dict):
            raise DomainError(
                "invalid_params", "Execution parameters must be an object"
            )
        if operation == "run":
            return asdict(environment.run(**params))
        return asdict(environment.edit(**params))

    try:
        _reply(execute)
    finally:
        if environment is not None:
            environment.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
