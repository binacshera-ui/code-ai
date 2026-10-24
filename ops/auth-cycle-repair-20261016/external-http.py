from pathlib import Path
import json,hashlib,datetime,subprocess,sys
root=Path(sys.argv[1]);ops=Path('/root/projects/code-ai/ops/auth-cycle-repair-20261016');origin='https://app-codex.bina-cshera.co.il';rows=[]
for label,route in [('ui','/'),('auth','/api/codex/auth/status')]:
    headers=ops/('public-'+label+'-headers.txt');body=ops/('public-'+label+('-status.json' if label=='auth' else '.html'))
    subprocess.run(['curl','--max-time','20','--fail','--silent','--show-error','--dump-header',str(headers),'--output',str(body),origin+route],check=True)
    text=headers.read_text();lines=text.splitlines();status=next(x for x in lines if x.startswith('HTTP/')).split()[1];assert status=='200'
    cc=next(x.split(':',1)[1].strip() for x in lines if x.lower().startswith('cache-control:'));assert 'no-store' in cc
    row=dict(route=route,status=int(status),cacheControl=cc)
    if label=='ui':
        assert hashlib.sha256(body.read_bytes()).hexdigest()==hashlib.sha256((root/'dist/public/index.html').read_bytes()).hexdigest();row['qualifiedHtmlMatched']=True
    rows.append(row)
report=dict(passed=True,origin=origin,checkedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),checks=rows)
(ops/'external-http.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
