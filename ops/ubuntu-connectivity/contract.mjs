import crypto from 'node:crypto';

export const REPORT_FIELDS = ['format','version','ubuntuUsername','ubuntuComputerName',
 'centralPublicKey','pciPublicKey','ubuntuHostPublicKey'];
export const HANDOFF_FIELDS = [...REPORT_FIELDS,'controllerPublicKey','centralLoopbackPort','centralRegistered','pciRegistered'];
export const CENTRAL_PIN = 'SHA256:6xNxgpDHSgKimuH18twY/iudAG2TH8sAFpOqEdLEBEM';
export const PCI_PIN = 'SHA256:thugowP6jCGGEeB0+moKaOOTl+Jx11crqaGG0Pd7B0I';

export function validateKey(value) {
 if(typeof value!=='string'||!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [A-Za-z0-9@._:-]+)?$/.test(value))throw new Error('INVALID_ED25519_KEY');
 const blob=Buffer.from(value.split(' ')[1],'base64');
 const type=Buffer.from('ssh-ed25519');
 if(blob.length!==51||blob.readUInt32BE(0)!==11||!blob.subarray(4,15).equals(type)||blob.readUInt32BE(15)!==32
   ||blob.toString('base64').replace(/=+$/,'')!==value.split(' ')[1].replace(/=+$/,''))throw new Error('INVALID_ED25519_WIRE_KEY');
 return 'SHA256:'+crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/,'');
}
export function validateReport(report) {
 if(!report||Object.keys(report).sort().join('|')!==[...REPORT_FIELDS].sort().join('|'))throw new Error('REPORT_REQUIRES_EXACT_SEVEN_FIELDS');
 if(report.format!=='code-ai-ubuntu-public-bootstrap'||report.version!==1)throw new Error('INVALID_REPORT_FORMAT');
 if(report.ubuntuUsername!=='refael'||report.ubuntuComputerName!=='gpu-lab')throw new Error('UBUNTU_IDENTITY_MISMATCH');
 const fingerprints=Object.fromEntries(['centralPublicKey','pciPublicKey','ubuntuHostPublicKey'].map(k=>[k,validateKey(report[k])]));
 if(new Set(Object.values(fingerprints)).size!==3)throw new Error('KEYS_MUST_BE_DISTINCT');
 return fingerprints;
}
export function handoff(report,controllerPublicKey,port,centralRegistered,pciRegistered) {
 validateReport(report);validateKey(controllerPublicKey);
 if(!Number.isSafeInteger(port)||port<1024||port>65535||port===44022)throw new Error('INVALID_DEDICATED_UBUNTU_PORT');
 if(typeof centralRegistered!=='boolean'||typeof pciRegistered!=='boolean')throw new Error('REGISTRATION_STATUS_NOT_VERIFIED');
 return {...report,format:'code-ai-ubuntu-server-registration',controllerPublicKey,centralLoopbackPort:port,centralRegistered,pciRegistered};
}

export function allowedCommand(command) {
 if(!['hostname','id','id -un'].includes(command))throw new Error('COMMAND_NOT_ALLOWLISTED');
 return command;
}
export function relayArguments(command) {
 return ['-T','-F','/root/.ssh/config','-o','BatchMode=yes','-o','ConnectTimeout=8',
  '-o','ClearAllForwardings=yes','-o','ForwardAgent=no','--','personal-ubuntu-ssh',allowedCommand(command)];
}
