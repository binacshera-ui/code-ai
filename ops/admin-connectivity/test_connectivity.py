import importlib.util
import json
import os
import pathlib
import pwd
import shlex
import socket
import subprocess
import tempfile
import time
import unittest

BASE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('worker',BASE/'host-worker.py')
worker=importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ContractTests(unittest.TestCase):
    def test_rejects_invalid_key(self):
        for key in ['ssh-rsa AAAA','ssh-ed25519 AAAA','ssh-ed25519 !!!']:
            with self.assertRaises(Exception):worker.fingerprint(key)

    def test_public_key_fingerprint(self):
        self.assertEqual(worker.fingerprint('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHMVNNx/YP7QzKNb+hC9cHb8750UwkqPHPKCuMiKvdpu'),
                         'SHA256:6xNxgpDHSgKimuH18twY/iudAG2TH8sAFpOqEdLEBEM')

    def test_atomic_preservation_and_private_backups(self):
        with tempfile.TemporaryDirectory() as folder:
            worker.ROOT=pathlib.Path(folder)/'private'
            target=pathlib.Path(folder)/'authorized_keys'
            target.write_bytes(b'existing-key\n')
            worker.write(target,b'existing-key\nnew-key\n')
            before=json.loads(next(worker.ROOT.glob('before-*.json')).read_text())
            self.assertTrue(before['existed'])
            self.assertEqual(before['contentBase64'],'ZXhpc3Rpbmcta2V5Cg==')
            self.assertEqual(target.read_bytes(),b'existing-key\nnew-key\n')
            self.assertEqual(next(worker.ROOT.glob('before-*.json')).stat().st_mode&0o777,0o600)

    def test_symlink_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            target=pathlib.Path(folder)/'link'
            target.symlink_to('/etc/passwd')
            with self.assertRaises(RuntimeError):worker.read(target)

    def test_proxy_is_pinned_to_main(self):
        peer={'id':'ubuntu','adminAlias':'code-ai-gpu-root','address':'127.0.0.1','port':44023,'login':'refael'}
        config=worker.config_for({'id':'pci'},pwd.getpwuid(os.getuid()),[peer])
        for clause in ['StrictHostKeyChecking yes','ForwardAgent no','code-ai-main-root code-ai-ubuntu-stream','HostKeyAlias code-ai-admin-ubuntu']:
            self.assertIn(clause,config)
        self.assertNotIn('ProxyCommand',worker.config_for({'id':'main'},pwd.getpwuid(os.getuid()),[peer]))

    def test_entrypoint_refuses_non_admin(self):
        result=subprocess.run(['sudo','-n','-u','nobody','python3',str(BASE/'admin-entrypoint.py'),'id'],capture_output=True)
        self.assertNotEqual(result.returncode,0)

    def test_source_config_must_be_checked_as_its_owner(self):
        account=pwd.getpwnam('nobody')
        with tempfile.TemporaryDirectory(prefix='code-ai-config-fixture-') as folder:
            os.chown(folder,account.pw_uid,account.pw_gid)
            config=pathlib.Path(folder)/'config'
            include=pathlib.Path(folder)/'include'
            include.write_text('Host fixture\n HostName 127.0.0.1\n')
            config.write_text('Include '+str(include)+'\n')
            for p in [config,include]:
                p.chmod(0o600);os.chown(p,account.pw_uid,account.pw_gid)
            wrong=subprocess.run(['ssh','-G','-F',str(config),'fixture'],capture_output=True)
            correct=subprocess.run(['sudo','-n','-u','nobody','ssh','-G','-F',str(config),'fixture'],capture_output=True)
            self.assertNotEqual(wrong.returncode,0)
            self.assertEqual(correct.returncode,0)


@unittest.skipUnless(os.geteuid()==0,'real SSH fixture requires local root')
class RealSshContract(unittest.TestCase):
    subsystem='internal-sftp'
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='code-ai-admin-fixture-',dir='/root')
        d=pathlib.Path(cls.temp.name)
        cls.directory=d
        for name in ['host','client']:
            subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(d/name)],check=True)
        with socket.socket() as s:
            s.bind(('127.0.0.1',0));cls.port=s.getsockname()[1]
        key=' '.join((d/'client.pub').read_text().split()[:2])
        prior=worker.ENTRY
        worker.ENTRY=BASE/'admin-entrypoint.py'
        (d/'keys').write_text(worker.key_line(key,'fixture')+'\n')
        worker.ENTRY=prior
        # The source file is not executable; a root-owned staged identical copy is.
        stage=d/'entrypoint'
        stage.write_bytes((BASE/'admin-entrypoint.py').read_bytes());stage.chmod(0o755)
        (d/'keys').write_text((d/'keys').read_text().replace(str(BASE/'admin-entrypoint.py'),str(stage)))
        known='[127.0.0.1]:'+str(cls.port)+' '+' '.join((d/'host.pub').read_text().split()[:2])+'\n'
        (d/'known').write_text(known)
        (d/'sshd').write_text(f'''Port {cls.port}
ListenAddress 127.0.0.1
HostKey {d}/host
PidFile {d}/pid
AuthorizedKeysFile {d}/keys
PermitRootLogin prohibit-password
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
AllowUsers root
Subsystem sftp {cls.subsystem}
LogLevel VERBOSE
''')
        subprocess.run(['/usr/sbin/sshd','-t','-f',str(d/'sshd')],check=True)
        cls.log=open(d/'log','wb')
        cls.server=subprocess.Popen(['/usr/sbin/sshd','-D','-e','-f',str(d/'sshd')],stdout=cls.log,stderr=cls.log)
        for _ in range(50):
            try:
                with socket.create_connection(('127.0.0.1',cls.port),timeout=.1):break
            except OSError:time.sleep(.05)
        cls.options=['-F','/dev/null','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',f'UserKnownHostsFile={d}/known','-o','IdentitiesOnly=yes','-i',str(d/'client')]

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate();cls.server.wait(timeout=5);cls.log.close();cls.temp.cleanup()

    def ssh(self,command,extra=()):
        return subprocess.run(['ssh',*self.options,'-p',str(self.port),*extra,'root@127.0.0.1',command],capture_output=True,text=True,timeout=10)

    def test_real_root_command_and_quoting(self):
        payload='space \"quotes\" $(literal) ; unicode שלום'
        command='python3 -c '+shlex.quote('import os,json;print(json.dumps([os.geteuid(),'+repr(payload)+']))')
        result=self.ssh(command)
        self.assertEqual(result.returncode,0,result.stderr+(self.directory/'log').read_text())
        self.assertEqual(json.loads(result.stdout),[0,payload])

    def test_real_tty(self):
        result=self.ssh('test -t 0 && id -u',extra=['-tt'])
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),'0')

    def test_real_sftp(self):
        result=subprocess.run(['sftp',*self.options,'-P',str(self.port),'-b','-','root@127.0.0.1'],input='ls /root\n',capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_forwarding_stays_disabled(self):
        result=subprocess.run(['ssh',*self.options,'-p',str(self.port),'-W','127.0.0.1:22','root@127.0.0.1'],capture_output=True,text=True,timeout=10)
        self.assertNotEqual(result.returncode,0)

class ExternalSftpContract(RealSshContract):
    subsystem='/usr/lib/openssh/sftp-server'


if __name__=='__main__':unittest.main(verbosity=2)
