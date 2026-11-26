set -eu
home=$(getent passwd "$(id -u)" | cut -d: -f6)
case "$home" in /*) ;; *) exit 70 ;; esac
exec head -c 16384 "$home/.bigbud/backend-services/$1/setup-complete-v1"
