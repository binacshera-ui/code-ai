#!/bin/bash
set -euo pipefail
nft_flags=()
if [ "${1:-}" = --check ]; then nft_flags=(-c); fi
# Only rules for the new VM interface are added. Existing CDE rules stay intact.
for protocol in tcp udp; do
  marker="code-ai-pci-outbound-${protocol}-v1"
  if nft list chain inet host_filter forward | grep -q "comment \"${marker}\""; then
    continue
  fi
  ports='{ 80, 443 }'
  if [ "$protocol" = udp ]; then ports='{ 53, 123 }'; fi
  nft "${nft_flags[@]}" insert rule inet host_filter forward \
    iifname '"virbr-code-ai"' oifname '"eno1"' \
    ip saddr 192.168.241.0/24 \
    ip daddr '!=' '{ 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 198.23.160.30/32, 224.0.0.0/4 }' \
    "$protocol" dport "$ports" ct state new,established accept comment "\"${marker}\""
done
