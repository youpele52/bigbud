"""Probe the production-version headless artifact without installing or patching it."""

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request

URL = "https://registry.npmjs.org/@xterm/headless/-/headless-6.1.0-beta.304.tgz"
SHA256 = "a5e939934ede7dfcce1ce0878e64b78cb36fb99173842f8392b9f55270c536aa"
LIMIT = 8 * 1024 * 1024

with urllib.request.urlopen(URL, timeout=30) as response:
    archive = response.read(LIMIT + 1)
if len(archive) > LIMIT or hashlib.sha256(archive).hexdigest() != SHA256:
    raise RuntimeError("Production headless artifact size/digest mismatch")
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
    member = package.getmember("package/lib-headless/xterm-headless.js")
    if not member.isfile() or member.size > LIMIT:
        raise RuntimeError("Invalid production headless bundle")
    source = package.extractfile(member).read(LIMIT + 1)
    metadata = json.load(package.extractfile("package/package.json"))
if metadata["version"] != "6.1.0-beta.304":
    raise RuntimeError("Unexpected production headless version")
result = subprocess.run(
    ["bun", "run", str(Path(__file__).with_name("checkpoint.production.driver.mjs"))],
    input=json.dumps({
        "source": source.decode("utf-8"),
        "version": metadata["version"],
        "archiveSha256": SHA256,
        "bundleSha256": hashlib.sha256(source).hexdigest(),
    }),
    text=True,
    capture_output=True,
    env={**os.environ, "NODE_DISABLE_COMPILE_CACHE": "1"},
    timeout=150,
)
if result.returncode:
    print("\n".join(result.stderr.splitlines()[-15:]), file=sys.stderr)
    raise SystemExit(result.returncode)
print(result.stdout, end="")
