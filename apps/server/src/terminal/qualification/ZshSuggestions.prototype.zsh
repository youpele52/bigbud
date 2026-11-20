# Qualification fixture only. Never sourced by production or from the workspace.
# SECONDS has NOT been qualified as an execution-host monotonic clock here.
# Absolute deadlines avoid receipt-relative renewal, but do not prove D_safe.
zmodload zsh/system || return 1
zmodload zsh/parameter || return 1
zmodload -F zsh/files b:zf_mv || return 1
umask 077
# Decline ownership rather than replacing user widgets, hooks, or native suffixes.
if [[ -n ${POSTDISPLAY-} || -n ${widgets[zle-line-pre-redraw]-} ||
      -n ${widgets[zle-line-init]-} || -n ${widgets[zle-line-finish]-} ||
      -n ${functions[_zsh_autosuggest_start]-} ||
      $(bindkey -l -L main) != 'bindkey -A emacs main' ||
      $(bindkey -M main '^I') != '"^I" expand-or-complete' ||
      $(bindkey -M main '^[[C') != '"^[[C" forward-char' ||
      $widgets[expand-or-complete] != builtin || $widgets[forward-char] != builtin ]]; then
  print -r -- unavailable > "$HOME/qualification-status"
  return 0
fi
setopt extendedglob
unsetopt beep
HISTFILE=$HOME/history
HISTSIZE=1000
SAVEHIST=0
PROMPT='qualification> '
RPROMPT=''
typeset -F SECONDS
typeset -F q_deadline=0 q_now=0
typeset -gi q_revision=0 q_epoch=0 q_sequence=0 q_suspended=1 q_revoked=0 q_editing=0
typeset -gi q_accepts=0 q_tabs=0 q_rights=0 q_render_revision=-1
typeset -g q_suffix='' q_buffer='' q_cursor='' q_keymap='' q_render_session=''
typeset -g q_render_lease='' q_render_epoch='' q_previous='' q_frame=''
# Test-only history in a disposable HOME; never read or merge real history.
print -s -- 'print sentinel; print -r -- executed > "$HOME/executed"'
print -s -- 'print -r -- QUALIFIED; : literal-punctuation'
print -s -- $'print bad\nmultiline'
print -s -- $'print bad\e[31m'
print -s -- $'print bad‮concealed'
print -s -- 'print unicode-λ'

q_clear() {
  region_highlight=( ${region_highlight:#*memo=bigbud-qualification} )
  POSTDISPLAY=''
  q_suffix=''
  q_render_revision=-1
}
q_safe() {
  (( ${#1} <= 4096 )) &&
    [[ $1 != *[$'\x00'-$'\x1f'$'\x7f'-$'\u009f'$'­؀'-$'؅'$'؜۝܏࢐'-$'࢑'$'࣢᠎​'-$'‏'$' '-$'‮'$'⁠'-$'⁯'$'﻿￹'-$'￻'$'\U000110bd\U000110cd\U00013430'-$'\U00013455'$'\U0001bca0'-$'\U0001bca3'$'\U0001d173'-$'\U0001d17a'$'\U000e0001\U000e0020'-$'\U000e007f']* ]]
}
q_valid() {
  (( q_editing && !q_suspended && !q_revoked && SECONDS < q_deadline )) &&
    [[ $KEYMAP == main && $CONTEXT == start ]]
}
q_snapshot() {
  # Test instrumentation only: never sent through the status/control protocol.
  {
    print -rl -- "${#BUFFER}" "${#POSTDISPLAY}"
    print -rn -- "$BUFFER$POSTDISPLAY"
    print -rl -- "$CURSOR" "$q_accepts" "$q_tabs" "$q_rights" "$q_revision" \
      "$q_suspended" "$q_sequence" "$q_deadline" "$SECONDS" "$q_revoked"
  } > "$HOME/snapshot.next"
  zf_mv -f -- "$HOME/snapshot.next" "$HOME/snapshot"
}
q_redraw() {
  local observation="${(qqq)BUFFER}:$CURSOR:$KEYMAP:$q_epoch"
  if [[ $observation != $q_previous ]]; then
    (( ++q_revision ))
    q_previous=$observation
    q_clear
  fi
  if ! q_valid; then
    q_clear
  elif [[ -z $q_suffix && -n $BUFFER ]] && (( CURSOR == ${#BUFFER} )) && q_safe "$BUFFER"; then
    local candidate event
    local -i inspected=0
    for event in ${(Onk)history}; do
      (( ++inspected > 1000 )) && break
      candidate=$history[$event]
      if [[ $candidate == "$BUFFER"?* ]] && q_safe "$candidate"; then
        q_suffix=${candidate[${#BUFFER}+1,-1]}
        q_buffer=$BUFFER q_cursor=$CURSOR q_keymap=$KEYMAP
        q_render_revision=$q_revision q_render_epoch=$q_epoch
        q_render_session=$BIGBUD_QUALIFICATION_SESSION
        q_render_lease=$BIGBUD_QUALIFICATION_LEASE
        POSTDISPLAY="$q_suffix  →"
        region_highlight+=( "${#BUFFER} $((${#BUFFER} + ${#POSTDISPLAY})) fg=8 memo=bigbud-qualification" )
        break
      fi
    done
  fi
  q_snapshot
}
q_accept() {
  if q_valid && (( q_render_revision == q_revision && CURSOR == ${#BUFFER} )) &&
      [[ -n $q_suffix && $BUFFER == "$q_buffer" && $CURSOR == "$q_cursor" &&
         $KEYMAP == "$q_keymap" && $q_epoch == "$q_render_epoch" &&
         $q_render_session == "$BIGBUD_QUALIFICATION_SESSION" &&
         $q_render_lease == "$BIGBUD_QUALIFICATION_LEASE" ]] &&
      q_safe "$BUFFER$q_suffix" && q_safe "$q_suffix"; then
    BUFFER+=$q_suffix
    CURSOR=${#BUFFER}
    (( ++q_accepts, ++q_revision ))
    q_clear
  else
    q_clear
    if [[ $1 == tab ]]; then
      (( ++q_tabs ))
      zle q_original_tab
    else
      (( ++q_rights ))
      zle q_original_right
    fi
  fi
}
q_line_init() { q_editing=1; (( ++q_epoch )); q_clear; q_redraw; }
q_line_finish() { q_editing=0; (( ++q_epoch )); q_clear; q_snapshot; }
q_suspend() { q_suspended=1; q_revoked=1; (( ++q_revision )); q_clear; }
q_control() {
  local chunk=''
  local -i count=0
  # One bounded nonblocking read per readiness callback; no foreground stdin.
  if ! sysread -i $q_control_fd -s 256 -t 0 -c count chunk; then
    q_suspend
    zle -F $q_control_fd
    q_redraw
    zle -R
    return
  fi
  q_frame+=$chunk
  if (( ${#q_frame} > 256 )); then
    q_suspend
    q_frame=''
  fi
  while [[ $q_frame == *$'\n'* ]]; do
    local frame=${q_frame%%$'\n'*}
    q_frame=${q_frame#*$'\n'}
    local -a fields
    fields=( ${(s: :)frame} )
    if (( ${#fields} != 6 )) || [[ $fields[1] != v1 ||
        $fields[2] != $BIGBUD_QUALIFICATION_SESSION ||
        $fields[3] != $BIGBUD_QUALIFICATION_LEASE ||
        $fields[4] != <1-999999> || $fields[6] != <0-999999>.<0-9999999999> ]]; then
      q_suspend
    elif (( fields[4] > q_sequence )); then
      q_sequence=$fields[4]
      q_now=$SECONDS
      if [[ $fields[5] == suspend ]]; then
        q_suspend
        # ACK only after invalidation; contains no candidate/buffer/history.
        print -r -u $q_status_fd -- "v1 $BIGBUD_QUALIFICATION_SESSION $BIGBUD_QUALIFICATION_LEASE $q_sequence suspended $q_revision"
      elif [[ $fields[5] == grant ]] && (( !q_revoked &&
          fields[6] > q_now && fields[6] <= q_now + 1.0 )); then
        q_deadline=$fields[6]
        q_suspended=0
        (( ++q_revision ))
        q_clear
      else
        q_suspend
      fi
    fi
  done
  q_redraw
  zle -R
}
# Only the disposable fixture's known emacs bindings are supported.
zle -A expand-or-complete q_original_tab
zle -A forward-char q_original_right
q_tab() { q_accept tab; }
q_right() { q_accept right; }
zle -N q_tab
zle -N q_right
zle -N zle-line-pre-redraw q_redraw
zle -N zle-line-init q_line_init
zle -N zle-line-finish q_line_finish
bindkey '^I' q_tab
bindkey '^[[C' q_right
exec {q_control_fd}< "$HOME/runtime/control"
exec {q_status_fd}> "$HOME/runtime/status"
zle -F $q_control_fd q_control
print -r -- ready > "$HOME/qualification-status"
print -r -u $q_status_fd -- "v1 $BIGBUD_QUALIFICATION_SESSION $BIGBUD_QUALIFICATION_LEASE ready"
