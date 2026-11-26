# OpenCode v2 discovery: an explicit configured path is the only candidate;
# otherwise the shared discovery (login `command -v`, `~/.opencode/bin`, known
# locations, npm launchers) applies. See owner_agent_proxy/provider_discovery.sh.
missing() {
    printf '\nbigbud-opencode-v2 %s missing\n' "$nonce" >&2
    exit 125
}

extra_candidates="$HOME/.opencode/bin/opencode"
