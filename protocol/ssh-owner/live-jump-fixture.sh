#!/bin/sh
# Pass the absolute Rust test executable, or --serve ROOT BINARY OWNER_ARGS.
# Invoke as a non-root account in the approved disposable Linux guest.
set -eu
[ "${BIGBUD_SSH_OWNER_LIVE_JUMP:-}" = approved-disposable ]
mode=test
if [ "${1:-}" = --serve ] || [ "${1:-}" = --serve-first-use ]; then
    mode=serve
    if [ "$1" = --serve-first-use ]; then mode=first-use; fi
    shift
    root="$1"
    shift
    suffix="${root#/tmp/bigbud-picker-linux-}"
    [ "$root" != "$suffix" ] || exit 1
    case "$suffix" in ''|*[!a-zA-Z0-9]*) exit 1 ;; esac
    [ -d "$root" ] || exit 1
    [ ! -L "$root" ] || exit 1
    [ "$(stat -c '%u:%a' "$root")" = "$(id -u):700" ]
    [ -z "$(ls -A -- "$root")" ]
else
    [ "$#" -eq 1 ]
fi
case "$1" in /*) ;; *) exit 1 ;; esac
test -f "$1" && test -x "$1"
uid="$(id -u)"
gid="$(id -g)"
[ "$uid" -gt 0 ] && [ "$gid" -gt 0 ]
umask 077
binary="$1"
shift
if [ "$mode" = test ]; then root="$(mktemp -d /tmp/bigbud-picker-linux-XXXXXXXX)"; fi
cleanup() {
    if [ -n "${b:-}" ]; then rm -rf -- "$b"; fi
    if [ -n "${d:-}" ]; then rm -rf -- "$d"; fi
    if [ "$mode" = test ]; then rm -rf -- "$root"; fi
}
trap cleanup EXIT
b="$(mktemp -d /tmp/bigbud-picker-linux-XXXXXXXX)"
d="$(mktemp -d /tmp/bigbud-picker-linux-XXXXXXXX)"
trap 'exit 1' HUP INT TERM

mkdir "$root/home" "$root/home/jump-fixture-folder"
printf 'picker:x:%s:%s:Picker:%s/home:/bin/sh\n' "$uid" "$gid" "$root" > "$root/passwd"
printf 'picker:x:%s:\n' "$gid" > "$root/group"
printf 'passwd: files\ngroup: files\nhosts: files\n' > "$root/nsswitch.conf"
for leg in "$b" "$d"; do
    /usr/bin/ssh-keygen -q -t ed25519 -N '' -C disposable-jump-proof -f "$leg/host"
    /usr/bin/ssh-keygen -q -t ed25519 -N '' -C disposable-jump-proof -f "$leg/identity"
done
/usr/bin/ssh-keygen -q -t ed25519 -N '' -C prior-bastion-pin -f "$b/prior-host"
printf 'restrict,port-forwarding,permitopen="127.0.0.1:22223" %s\n' "$(cat "$b/identity.pub")" > "$b/authorized"
printf 'restrict %s\n' "$(cat "$d/identity.pub")" > "$d/authorized"

write_config() {
    directory="$1"
    cat > "$directory/config" <<CONFIG
ListenAddress 127.0.0.1:$2
HostKey $directory/host
AuthorizedKeysFile $directory/authorized
StrictModes no
AllowUsers picker
PidFile none
LogLevel VERBOSE
UseDNS no
UsePAM no
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitUserEnvironment no
PermitUserRC no
PermitTTY no
CONFIG
    shift 2
    printf '%s\n' "$@" >> "$directory/config"
}
write_config "$b" 22222 'AllowTcpForwarding local' 'AllowStreamLocalForwarding no' \
    'PermitOpen 127.0.0.1:22223' 'MaxSessions 0'
write_config "$d" 22223 'DisableForwarding yes'

cp "$b/identity" "$root/b-identity"
cp "$d/identity" "$root/d-identity"
if [ "$mode" = first-use ]; then
    : > "$root/b-pins"
    : > "$root/d-pins"
else
    printf '[127.0.0.1]:22222 %s\n' "$(cat "$b/host.pub")" > "$root/b-pins"
printf '[127.0.0.1]:22223 %s\n' "$(cat "$d/host.pub")" > "$root/d-pins"
fi
cat > "$root/ssh-config" <<CONFIG
Host workspace
    HostName 127.0.0.1
    Port 22223
    User picker
    ProxyJump bastion
    IdentityFile $root/d-identity
    UserKnownHostsFile $root/d-pins
Host bastion
    HostName 127.0.0.1
    Port 22222
    User picker
    IdentityFile $root/b-identity
    UserKnownHostsFile $root/b-pins
CONFIG

/usr/bin/bwrap --unshare-user --uid "$uid" --gid "$gid" --unshare-pid --unshare-net \
    --unshare-ipc --unshare-uts --disable-userns --cap-drop ALL --new-session --die-with-parent \
    --clearenv --dev /dev --proc /proc --tmpfs /tmp --dir /run/sshd --dir /var/empty \
    --ro-bind /usr/bin /usr/bin --ro-bind /bin /bin --ro-bind /usr/lib /usr/lib \
    --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 --ro-bind-try /usr/lib64 /usr/lib64 \
    --ro-bind-try /usr/libexec /usr/libexec --ro-bind /usr/sbin/sshd /usr/sbin/sshd \
    --ro-bind "$root/passwd" /etc/passwd --ro-bind "$root/group" /etc/group \
    --ro-bind "$root/nsswitch.conf" /etc/nsswitch.conf --bind "$root" "$root" \
    --bind "$b" "$b" --bind "$d" "$d" --ro-bind "$binary" /test-binary --remount-ro /tmp --remount-ro / --chdir "$root" \
    --setenv LC_ALL C --setenv PATH /usr/bin:/bin --setenv HOME "$root/home" \
    --setenv BIGBUD_JUMP_B "$b" --setenv BIGBUD_JUMP_D "$d" \
    --setenv BIGBUD_SSH_OWNER_PICKER_RO_SYSTEM_TOOLS 1 \
    --setenv BIGBUD_SSH_OWNER_PICKER_JUMP approved-disposable \
    --setenv BIGBUD_SSH_OWNER_PICKER_PROOF 1 \
    --setenv BIGBUD_SSH_OWNER_LIVE_JUMP approved-disposable -- /bin/sh -eu -c '
        umask 077
        start() {
            /usr/sbin/sshd -D -e -f "$1/config" </dev/null >"$3.log" 2>&1 &
            daemon=$!
            attempts=0
            until grep -Fq "Server listening on 127.0.0.1 port $2." "$3.log"; do
                if ! kill -0 "$daemon" 2>/dev/null || [ "$attempts" -ge 50 ]; then
                    tail -n 10 "$3.log" >&2
                    exit 1
                fi
                attempts=$((attempts + 1))
                sleep 0.1
            done
        }
        start "$BIGBUD_JUMP_B" 22222 b
        start "$BIGBUD_JUMP_D" 22223 d
        mode="$1"
        shift
        if [ "$mode" = first-use ]; then
            export BIGBUD_SSH_OWNER_JUMP_FIRST_USE=1
        fi
        if [ "$mode" != test ]; then exec /test-binary "$@"; fi
        /test-binary --ignored --exact owner::jump_picker_tests::bound_alias_browses_through_selected_owner_dispatch
        exec /test-binary --ignored --exact transport::posix_master::tests::live_jump::stock_openssh_forwards_only_after_authenticating_the_pinned_bastion
    ' jump-fixture "$mode" "$@"
