#!/usr/bin/python3
"""Owner-authorized administrative SSH sessions, separate from service keys.

The authenticated key intentionally grants arbitrary root commands. This is not
a command sandbox. The SSH transport still authenticates a normal, existing
account on hosts that prohibit direct root login.
"""
import os
import select
import socket
import sys


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise SystemExit('administrative entrypoint requires sudo and one command')
    command = sys.argv[1]
    if command == 'code-ai-ubuntu-stream':
        # A raw SSH hop, never an unverified replacement for Ubuntu host auth.
        if socket.gethostname() != 'web':
            raise SystemExit('Ubuntu tunnel is available only on main')
        with socket.create_connection(('127.0.0.1', 44023), timeout=10) as peer:
            peer.settimeout(None)
            inputs = [sys.stdin.buffer, peer]
            while peer in inputs:
                for ready in select.select(inputs, [], [peer])[0]:
                    if ready is peer:
                        data = peer.recv(65536)
                        if not data:
                            return
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
                    else:
                        data = os.read(0, 65536)
                        if data:
                            peer.sendall(data)
                        else:
                            inputs.remove(sys.stdin.buffer)
                            peer.shutdown(socket.SHUT_WR)
        return
    os.environ.update(HOME='/root', USER='root', LOGNAME='root',
                      PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
    os.environ.pop('SSH_AUTH_SOCK', None)
    os.chdir('/root')
    # sshd appends a space to the subsystem command even without arguments.
    # Execute SFTP directly: shell startup output must not corrupt its protocol.
    if command.strip() in ('internal-sftp', '/usr/lib/openssh/sftp-server'):
        os.execv('/usr/lib/openssh/sftp-server', ['sftp-server'])
    if command:
        os.execv('/bin/bash', ['bash', '-lc', command])
    os.execv('/bin/bash', ['bash', '-l'])


if __name__ == '__main__':
    main()
