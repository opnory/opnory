#!/usr/bin/env python3
"""Materialize SeaweedFS S3 identity config (s3.json) from a template + .env.

SeaweedFS (verified in source, version 4.45, weed/s3api/auth_credentials.go)
performs a literal json.Unmarshal of the -s3.config file at startup and does NOT
expand ${VAR} placeholders. The config therefore must be rendered to concrete,
gitignored JSON before `docker compose up`. This script is that renderer.

Usage:
    python3 render-s3-config.py <template> <output>

Example:
    python3 render-s3-config.py s3.bootstrap.json.example s3.json

Exit codes: 0 success; 1 unresolved placeholder / invalid JSON / bad identity set.
"""
import json
import re
import sys
from pathlib import Path


def load_env(path: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v
    return env


def main() -> int:
    if len(sys.argv) != 3:
        sys.stderr.write("usage: render-s3-config.py <template> <output>\n")
        return 1
    template_path, out_path = sys.argv[1], sys.argv[2]

    env = load_env(str(Path(__file__).parent / ".env"))
    text = Path(template_path).read_text()
    for k, v in env.items():
        text = text.replace("${%s}" % k, v)

    unresolved = re.findall(r"\$\{[^}]+\}", text)
    if unresolved:
        sys.stderr.write(f"unresolved placeholders: {unresolved}\n")
        return 1

    try:
        doc = json.loads(text)
    except Exception as e:
        sys.stderr.write(f"invalid JSON after substitution: {e}\n")
        return 1

    identities = doc.get("identities", [])
    if not identities:
        sys.stderr.write("no identities in rendered config\n")
        return 1
    seen_keys: set[str] = set()
    for ident in identities:
        for cred in ident.get("credentials", []):
            ak, sk = cred.get("accessKey", ""), cred.get("secretKey", "")
            if not ak or not sk:
                sys.stderr.write(f"identity {ident.get('name')} has empty credential\n")
                return 1
            if ak in seen_keys:
                sys.stderr.write(f"duplicate accessKey across identities\n")
                return 1
            seen_keys.add(ak)

    Path(out_path).write_text(text)
    names = [i["name"] for i in identities]
    print(f"rendered {out_path}: identities={names}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
