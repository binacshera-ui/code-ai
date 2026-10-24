#!/bin/bash
set -euo pipefail
cd /var/tmp/code-ai-pci-provision-20261006
test "$(id -u)" = 0
test ! -e /srv/beam254/code-ai-vms/pci/root.qcow2
if virsh dominfo code-ai-pci >/dev/null 2>&1; then echo 'Existing VM: stop before changing it.' >&2; exit 78; fi
if virsh net-info code-ai-pci-net >/dev/null 2>&1; then echo 'Existing network: stop before changing it.' >&2; exit 78; fi
for tool in virsh qemu-img cloud-localds virt-xml-validate nft; do command -v "$tool" >/dev/null; done
virt-xml-validate domain.xml domain
virt-xml-validate network.xml network
test "$(df -B1 --output=avail /srv/beam254 | tail -1)" -gt 142000000000
! ip route show | grep -q '192\.168\.241\.'
actual=$(sha512sum /var/lib/binapay-cde/images/debian-13-generic-amd64.qcow2 | cut -d ' ' -f1)
awk -v digest="$actual" '$1 == digest {matched=1} END {exit !matched}' /var/lib/binapay-cde/images/SHA512SUMS
bash network-guard.sh --check
if [ "${1:-}" = --check ]; then
  echo 'Preflight passed: domain/schema, free space, subnet, tools, base-image checksum.'
  exit 0
fi
for vm in binapay-edge binapay-gateway binapay-db binapay-keys; do
  test "$(virsh domstate "$vm")" = running
  virsh dumpxml --inactive "$vm" | sha256sum >"baseline-${vm}.sha256"
done
install -d -m 755 /srv/beam254/code-ai-vms/pci /usr/local/lib/code-ai-pci
qemu-img create -f qcow2 -F qcow2 -b /var/lib/binapay-cde/images/debian-13-generic-amd64.qcow2 /srv/beam254/code-ai-vms/pci/root.qcow2 32G
cloud-localds --network-config=network-config /srv/beam254/code-ai-vms/pci/seed.iso user-data meta-data
chown libvirt-qemu:libvirt-qemu /srv/beam254/code-ai-vms/pci/root.qcow2 /srv/beam254/code-ai-vms/pci/seed.iso
chmod 640 /srv/beam254/code-ai-vms/pci/root.qcow2 /srv/beam254/code-ai-vms/pci/seed.iso
install -m 755 network-guard.sh /usr/local/lib/code-ai-pci/network-guard.sh
install -m 644 code-ai-pci-network-guard.service /etc/systemd/system/code-ai-pci-network-guard.service
systemctl daemon-reload
systemctl enable --now code-ai-pci-network-guard.service
virsh net-define network.xml
virsh net-autostart code-ai-pci-net
virsh net-start code-ai-pci-net
virsh define domain.xml
virsh autostart code-ai-pci
virsh start code-ai-pci
for vm in binapay-edge binapay-gateway binapay-db binapay-keys; do
  test "$(virsh domstate "$vm")" = running
  virsh dumpxml --inactive "$vm" | sha256sum -c "baseline-${vm}.sha256"
done
echo 'New isolated VM started; existing VM definitions unchanged.'
