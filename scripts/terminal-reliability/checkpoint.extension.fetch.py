"""Fetch verified paired experiment inputs; never mutate installed dependencies."""
import hashlib
import io
from pathlib import Path
import sys
import tarfile
import urllib.request

destination = Path(sys.argv[1]).resolve()
destination.mkdir(parents=True, exist_ok=True)
inputs = {
    "headless": ("https://registry.npmjs.org/@xterm/headless/-/headless-6.0.0.tgz", "package/lib-headless/xterm-headless.js", "07e4970b1674e7ef6cbd57c8c17746eaadcd41aa7df5b33695fd649e6ec4d78a"),
    "browser": ("https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz", "package/lib/xterm.js", "908e66e04af6c8dc6b00dd3b54de088e2e81e5ed866284fd6c2fb3c2d1c7a3f6"),
}
for name, (url, member, digest) in inputs.items():
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError(f"Unverified {name} archive")
    archive = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
    source = archive.extractfile(member).read()
    (destination / f"{name}.cjs").write_bytes(source)
    # A source-level maintenance input, not a copy of generated minified code.
    inventory = "package/src/common/InputHandler.ts"
    if name == "browser":
        (destination / "InputHandler.pinned.ts").write_bytes(archive.extractfile(inventory).read())
    print(name, digest, hashlib.sha256(source).hexdigest())
