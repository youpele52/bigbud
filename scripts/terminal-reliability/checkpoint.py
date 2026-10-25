"""Reproduce pinned xterm limitations without installing packages or writing terminal data."""
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import urllib.request

inputs = {
    "headless": ("https://registry.npmjs.org/@xterm/headless/-/headless-6.0.0.tgz", "package/lib-headless/xterm-headless.js"),
    "serialize": ("https://registry.npmjs.org/@xterm/addon-serialize/-/addon-serialize-0.14.0.tgz", "package/lib/addon-serialize.js"),
}
expected = {
    "headless": "07e4970b1674e7ef6cbd57c8c17746eaadcd41aa7df5b33695fd649e6ec4d78a",
    "serialize": "f9a290923dc9c6178446e3fc082c29812a7096a1664fd7bf904022c141c5bbfb",
}
payload = {"hashes": {"python": platform.python_version()}}
for name, (url, member) in inputs.items():
    with urllib.request.urlopen(url, timeout=30) as response:
        archive = response.read(8 * 1024 * 1024 + 1)
    if len(archive) > 8 * 1024 * 1024:
        raise RuntimeError("Fixture artifact exceeded fetch budget")
    if hashlib.sha256(archive).hexdigest() != expected[name]:
        raise RuntimeError("Pinned artifact digest mismatch")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
        source = package.extractfile(member).read()
    payload[name] = source.decode("utf-8")
    payload["hashes"][name] = {"url": url, "archiveSha256": hashlib.sha256(archive).hexdigest(), "bundleSha256": hashlib.sha256(source).hexdigest()}
result = subprocess.run(["node", str(Path(__file__).with_name("checkpoint.runner.mjs"))],
    input=json.dumps(payload), text=True, env={**os.environ, "NODE_DISABLE_COMPILE_CACHE": "1"}, capture_output=True, timeout=60)
if result.returncode:
    print("\n".join(result.stderr.splitlines()[-12:]), file=sys.stderr)
    raise SystemExit(result.returncode)
print(result.stdout, end="")
