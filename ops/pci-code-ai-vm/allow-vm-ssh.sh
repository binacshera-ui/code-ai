#!/bin/bash
# Add only the new Code AI VM to the established bastion's forwarding allowlist.
set -euo pipefail
test "$(id -u)" = 0
target=/etc/ssh/sshd_config.d/zz-binapay-cde-bastion.conf
test -f "$target" && test ! -L "$target"
old='10.77.50.2:22 10.77.50.3:22 10.77.50.4:22 10.77.50.5:22'
new="$old 192.168.241.2:22"
actual=$(awk '$1 == "PermitOpen" {$1=""; sub(/^[[:space:]]+/, ""); print}' "$target")
if [ "$actual" = "$new" ]; then
  /usr/sbin/sshd -t
  echo 'SSH allowlist already includes only the approved additional VM.'
  exit 0
fi
test "$actual" = "$old"
test "$(awk '$1 == "Match" && $2 == "User" && $3 == "binapay-admin" {n++} END {print n+0}' "$target")" = 1
/usr/sbin/sshd -t
candidate=$(mktemp /etc/ssh/sshd_config.d/.code-ai-pci-ssh.XXXXXX)
trap 'test ! -f "$candidate" || unlink "$candidate"' EXIT
awk '$1 == "PermitOpen" {$0=$0 " 192.168.241.2:22"} {print}' "$target" > "$candidate"
chmod --reference="$target" "$candidate"
chown --reference="$target" "$candidate"
if [ "${1:-}" = --check ]; then
  echo 'Preflight passed: one existing scoped allowlist; exactly one approved destination added.'
  exit 0
fi
backup=$(mktemp /var/backups/code-ai-pci-sshd-before.XXXXXX)
install -m 600 "$target" "$backup"
mv "$candidate" "$target"
if ! /usr/sbin/sshd -t; then
  install -m 600 "$backup" "$target"
  echo 'Candidate validation failed; original configuration restored without reload.' >&2
  exit 78
fi
systemctl reload ssh
systemctl is-active --quiet ssh
echo 'Approved VM SSH forwarding enabled; existing destinations retained; SSH master gracefully reloaded.'
echo "Recovery configuration: $backup"
