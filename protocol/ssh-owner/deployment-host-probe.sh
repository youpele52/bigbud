set -eu
home=$(getent passwd "$(id -u)" | cut -d: -f6)
case "$home" in /*) ;; *) exit 70 ;; esac
printf 'home=%s\n' "$home"
printf 'arch=%s\n' "$(uname -m)"
for key in "$2/ssh_host_ed25519_key.pub" "$2/ssh_host_ecdsa_key.pub" "$2/ssh_host_rsa_key.pub"; do
  if [ -r "$key" ]; then printf 'host=%s\n' "$(cut -d ' ' -f 1,2 "$key" | sha256sum | cut -d ' ' -f 1)"; break; fi
done
for done_file in "$home"/.bigbud/backend-services/*/setup-complete-v1; do
  [ -f "$done_file" ] || continue
  if grep -q "\"requestId\":\"$1\"" "$done_file"; then printf 'completed=%s\n' "$(basename "$(dirname "$done_file")")"; fi
done
