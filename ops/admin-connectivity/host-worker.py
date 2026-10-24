"""Invoked over an already pinned maintenance connection; no secrets returned."""
import base64
import hashlib
import json
import os
import pathlib
import pwd
import shlex
import stat
import subprocess
import tempfile
import uuid

ROOT = pathlib.Path('/var/lib/code-ai/admin-connectivity/20261013')
ENTRY = pathlib.Path('/usr/local/libexec/code-ai/admin-ssh-entrypoint')
MARK = 'code-ai-admin-mesh-v1'


def run(argv, data=None, timeout=25):
    result = subprocess.run(argv, input=data, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Do not print arbitrary stderr, command output or authentication data.
        classes=['Permission denied','Connection closed','Connection reset','Connection timed out','Broken pipe',
                 'Host key verification failed','Bad owner or permissions','Received message too long',
                 'kex_exchange_identification','subsystem request failed','No such file','Failure']
        category=','.join(c for c in classes if c in result.stderr)
        raise RuntimeError('command failed: ' + pathlib.Path(argv[0]).name + ':' + str(result.returncode) + ':' + category)
    return result.stdout.strip()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def fingerprint(key):
    algorithm, encoded = key.split()[:2]
    raw = base64.b64decode(encoded, validate=True)
    if algorithm != 'ssh-ed25519' or len(raw) != 51 or raw[:19] != b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20':
        raise RuntimeError('invalid ED25519 public key')
    return 'SHA256:' + base64.b64encode(hashlib.sha256(raw).digest()).decode().rstrip('=')


def read(path):
    path = pathlib.Path(path)
    if path.is_symlink():
        raise RuntimeError('refusing symlink: ' + str(path))
    return path.read_bytes() if path.exists() else b''


def write(path, content, mode=0o600, uid=0, gid=0):
    """Private before-image, compare-and-set, atomic replacement, same owner."""
    path = pathlib.Path(path)
    old = read(path)
    if old == content:
        return
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(ROOT, 0o700)
    ledger = ROOT / ('before-' + hashlib.sha256(str(path).encode()).hexdigest()[:20] + '.json')
    if not ledger.exists():
        previous = path.stat() if path.exists() else None
        value = {'path':str(path), 'existed':previous is not None,
                 'mode':stat.S_IMODE(previous.st_mode) if previous else None,
                 'uid':previous.st_uid if previous else None, 'gid':previous.st_gid if previous else None,
                 'contentBase64':base64.b64encode(old).decode()}
        fd = os.open(ledger, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as file:
            json.dump(value, file)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, stage = tempfile.mkstemp(prefix='.code-ai-admin-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb') as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        if read(path) != old:
            raise RuntimeError('concurrent modification: ' + str(path))
        os.replace(stage, path)
    finally:
        if os.path.exists(stage):
            os.unlink(stage)


def paths(user):
    account = pwd.getpwnam(user)
    return account, pathlib.Path(account.pw_dir) / '.ssh'


def key_line(key, source):
    fingerprint(key)
    command = 'sudo -n -H ' + str(ENTRY) + ' "$SSH_ORIGINAL_COMMAND"'
    escaped = command.replace('\\', '\\\\').replace('"', '\\"')
    return 'restrict,pty,command="' + escaped + '" ' + key + ' ' + MARK + ':' + source


def config_for(host, account, peers):
    home = pathlib.Path(account.pw_dir) / '.ssh'
    result = []
    for peer in peers:
        if peer['id'] == host['id']:
            continue
        result.extend([
            'Host ' + peer['adminAlias'], '  HostName ' + peer['address'],
            '  Port ' + str(peer['port']), '  User ' + peer['login'],
            '  IdentityFile ' + str(home / 'code-ai-admin-v1_ed25519'),
            '  UserKnownHostsFile ' + str(home / 'code-ai-admin-v1_known_hosts'),
            '  HostKeyAlias code-ai-admin-' + peer['id'], '  HostKeyAlgorithms ssh-ed25519',
            '  StrictHostKeyChecking yes', '  IdentitiesOnly yes', '  BatchMode yes',
            '  ForwardAgent no', '  ForwardX11 no', '  ConnectTimeout 10',
            '  ServerAliveInterval 15', '  ServerAliveCountMax 3',
        ])
        if peer['id'] == 'ubuntu' and host['id'] != 'main':
            result.append('  ProxyCommand /usr/bin/ssh -F ' + str(home / 'code-ai-admin-v1_config') +
                          ' -T code-ai-main-root code-ai-ubuntu-stream')
    return '\n'.join(result + ['Host *', ''])


def invariants(host):
    hashes = {}
    for filename in host['protected']:
        path = pathlib.Path(filename)
        if path.exists():
            hashes[filename] = digest(path.read_bytes())
    processes = {}
    for service in host['services']:
        result = subprocess.run(['systemctl', 'show', service, '-p', 'MainPID', '--value'], capture_output=True, text=True)
        if result.returncode == 0:
            processes[service] = result.stdout.strip()
    return {'files':hashes, 'services':processes}


def execute(request):
    host = request['host']
    if os.geteuid() != 0 or os.uname().nodename != host['hostname']:
        raise RuntimeError('host or maintenance identity mismatch')
    action = request['action']
    if action == 'audit':
        key = ' '.join(read(host['hostKey']).decode().split()[:2])
        if fingerprint(key) != host['pin']:
            raise RuntimeError('HOST_KEY_MISMATCH')
        for user in host['users']:
            account, home = paths(user)
            read(home / 'config')
            for name in ['code-ai-admin-v1_config', 'code-ai-admin-v1_known_hosts', 'code-ai-admin-v1_ed25519']:
                if (home / name).exists():
                    raise RuntimeError('admin mesh already exists; reconcile rather than overwrite')
        read(host['authorizedKeys'])
        if ENTRY.exists():
            raise RuntimeError('entrypoint already exists; reconcile')
        run(['/usr/bin/sudo','-n','-u',host['login'],'sudo','-n','id','-u'])
        if not pathlib.Path('/usr/lib/openssh/sftp-server').is_file():
            raise RuntimeError('SFTP executable missing')
        return {'host':host['id'],'publicKey':key,'pin':fingerprint(key),'invariants':invariants(host),
                'users':[{'name':u,'uid':pwd.getpwnam(u).pw_uid,'home':pwd.getpwnam(u).pw_dir} for u in host['users']]}
    if action == 'prepare':
        compile(request['entrypoint'], str(ENTRY), 'exec')
        write(ENTRY, request['entrypoint'].encode(), 0o755)
        keys = []
        for user in host['users']:
            account, home = paths(user)
            if not home.exists():
                home.mkdir(mode=0o700)
                os.chown(home, account.pw_uid, account.pw_gid)
            key = home / 'code-ai-admin-v1_ed25519'
            if key.exists():
                raise RuntimeError('key already exists')
            run(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-f',str(key),'-C',MARK+':'+host['id']+':'+user])
            os.chmod(key,0o600)
            for path in [key,pathlib.Path(str(key)+'.pub')]:
                os.chown(path,account.pw_uid,account.pw_gid)
            public = ' '.join(read(str(key)+'.pub').decode().split()[:2])
            keys.append({'host':host['id'],'user':user,'publicKey':public,'fingerprint':fingerprint(public)})
        return {'keys':keys}
    if action == 'update-entrypoint':
        if digest(read(ENTRY)) != request['expectedSha256']:
            raise RuntimeError('entrypoint changed concurrently')
        compile(request['entrypoint'],str(ENTRY),'exec')
        write(ENTRY,request['entrypoint'].encode(),0o755)
        return {'host':host['id'],'sha256':digest(read(ENTRY)),'invariants':invariants(host)}
    if action == 'activate':
        original = read(host['authorizedKeys'])
        lines = [key_line(k['publicKey'],k['host']+':'+k['user']) for k in request['keys'] if k['host'] != host['id']]
        registered=[line for line in original.decode().splitlines() if MARK in line]
        if registered and registered != lines:
            raise RuntimeError('managed key registration conflicts')
        target = pathlib.Path(host['authorizedKeys'])
        previous = target.stat() if target.exists() else None
        account = pwd.getpwnam(host['login'])
        desired=original if registered else original + (b'\n' if original and not original.endswith(b'\n') else b'') + ('\n'.join(lines)+'\n').encode()
        write(target, desired,
              stat.S_IMODE(previous.st_mode) if previous else 0o600,
              previous.st_uid if previous else account.pw_uid, previous.st_gid if previous else account.pw_gid)
        for user in host['users']:
            account, home = paths(user)
            config = config_for(host,account,request['peers']).encode()
            known = ''.join('code-ai-admin-'+p['id']+' '+p['publicKey']+'\n' for p in request['peers']).encode()
            write(home/'code-ai-admin-v1_config',config,0o600,account.pw_uid,account.pw_gid)
            write(home/'code-ai-admin-v1_known_hosts',known,0o600,account.pw_uid,account.pw_gid)
            originalConfig=read(home/'config')
            include=('Include '+str(home/'code-ai-admin-v1_config')+'\n').encode()
            if include in originalConfig and not originalConfig.startswith(include):
                raise RuntimeError('managed include exists in an unexpected position')
            write(home/'config',originalConfig if originalConfig.startswith(include) else include+originalConfig,0o600,account.pw_uid,account.pw_gid)
            for peer in request['peers']:
                if peer['id'] != host['id']:
                    run(['/usr/bin/sudo','-n','-u',user,'/usr/bin/ssh','-G','-F',str(home/'config'),peer['adminAlias']])
        if invariants(host) != request['invariants']:
            raise RuntimeError('protected configuration or daemon changed')
        return {'host':host['id'],'keysAdded':len(lines),'existingKeysPreserved':read(target).startswith(original),
                'protectedStateUnchanged':True,'rootEntrySha256':digest(read(ENTRY))}
    if action == 'verify':
        checks = []
        # Test the exact explicit key/config as each source account, not the
        # maintenance connection or a root account standing in for the user.
        proof = "import os,socket,tempfile,pathlib,json; d=pathlib.Path(tempfile.mkdtemp(prefix='code-ai-admin-check-',dir='/root')); p=d/'proof'; p.write_text('write-read'); ok=p.read_text()=='write-read'; p.unlink(); d.rmdir(); print(json.dumps({'hostname':socket.gethostname(),'uid':os.geteuid(),'rootWriteRead':ok}))"
        for user in host['users']:
            account, home = paths(user)
            prefix=['/usr/bin/sudo','-n','-u',user]
            for peer in request['peers']:
                if peer['id'] == host['id']:
                    continue
                row={'source':host['id'],'user':user,'target':peer['id']}
                ssh=['/usr/bin/ssh','-F',str(home/'config'),peer['adminAlias']]
                try:
                    result=json.loads(run(prefix+ssh+['python3 -c '+shlex.quote(proof)],timeout=40))
                    if result != {'hostname':peer['hostname'],'uid':0,'rootWriteRead':True}:
                        raise RuntimeError('wrong identity or write failure')
                    row.update(result)
                    row['pty']=run(prefix+['/usr/bin/ssh','-tt','-F',str(home/'config'),peer['adminAlias'],'test -t 0 && id -u'],timeout=40).strip()=='0'
                    with tempfile.TemporaryDirectory(prefix='code-ai-admin-sftp-') as folder:
                        os.chown(folder,account.pw_uid,account.pw_gid)
                        source=pathlib.Path(folder)/'source'
                        received=pathlib.Path(folder)/'received'
                        payload=uuid.uuid4().hex
                        source.write_text(payload)
                        os.chown(source,account.pw_uid,account.pw_gid)
                        remote='/root/.code-ai-admin-probe-'+uuid.uuid4().hex
                        batch='put '+str(source)+' '+remote+'\nget '+remote+' '+str(received)+'\nrm '+remote+'\n'
                        run(prefix+['/usr/bin/sftp','-q','-b','-','-F',str(home/'config'),peer['adminAlias']],data=batch,timeout=45)
                        row['sftpRootWriteRead']=received.read_text()==payload
                    row['ok']=row['pty'] and row['sftpRootWriteRead']
                except Exception as error:
                    row.update(ok=False,error=type(error).__name__+': '+str(error))
                checks.append(row)
        return {'checks':checks,'invariants':invariants(host)}
    raise RuntimeError('unknown action')
