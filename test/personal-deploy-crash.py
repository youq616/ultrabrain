#!/usr/bin/env python3
"""CI-only process-death fixture; recovery uses the public CLI and real manager."""
import argparse
import importlib.util
import os
from pathlib import Path
import pwd


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    actual_home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    expected_home = actual_home / "ultrabrain-personal-services-test"
    if (os.getuid() == 0 or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("ULTRABRAIN_TEST_ALLOW_WRITE") != "1"
            or os.environ.get("ULTRABRAIN_SYSTEMD_TEST") != "1"
            or os.environ.get("ULTRABRAIN_HOME") != str(expected_home)):
        raise SystemExit("Disposable ordinary-user CI fixture required")
    p = argparse.ArgumentParser()
    for flag in ("home", "bun", "source", "export", "expected-plan", "expected-deployment"):
        p.add_argument("--" + flag, required=True)
    p.add_argument("--port", type=int, required=True)
    args = p.parse_args()
    if Path(args.home) != expected_home:
        raise SystemExit("Wrong fixture installation")
    root = Path(__file__).resolve().parent.parent
    services = load("ci_personal_services", root / "scripts/personal-services.py")
    deploy = load("ci_personal_deploy", root / "scripts/personal-deploy.py")
    value = services.plan(root, expected_home, Path(args.bun), source=args.source, port=args.port)

    def crash(label):
        if label == "after_unit:ultrabrain-personal.target":
            os._exit(73)  # No finally block: journal and links must survive abrupt process death.

    deploy.Context(expected_home, fault=crash).apply(
        value, Path(args.export), args.expected_plan, args.expected_deployment)
    raise SystemExit("The required transaction checkpoint was not reached")


if __name__ == "__main__":
    main()
