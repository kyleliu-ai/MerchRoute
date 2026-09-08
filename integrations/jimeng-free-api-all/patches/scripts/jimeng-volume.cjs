// Fixed-path storage helper. Run only with a verified image and named volume.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = '/app/data';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function scan() {
  const files = [];
  function visit(relative) {
    const full = path.join(root,relative), s = fs.lstatSync(full);
    assert.ok(!s.isSymbolicLink(), 'Storage links are forbidden');
    assert.ok(s.isFile() || s.isDirectory(), 'Special storage files are forbidden');
    assert.ok(!s.isFile() || s.nlink === 1, 'Hard-linked storage files are forbidden');
    files.push({ path:relative, type:s.isDirectory()?'directory':'file', uid:s.uid,gid:s.gid,mode:s.mode & 0o777,
      ...(s.isFile()?{size:s.size,sha256:sha(fs.readFileSync(full))}:{}) });
    if (s.isDirectory()) for (const name of fs.readdirSync(full).sort()) visit(relative ? relative+'/'+name : name);
  }
  visit('');
  return files;
}
function report(files) {
  const stores = {};
  for (const [name,schema] of [['image-task-store.json',2],['image-upload-store.json',1]]) {
    if (!files.some((f) => f.path === name)) { stores[name] = {missing:true}; continue; }
    const data = JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
    const records = Array.isArray(data) && schema === 2 ? data : data.records;
    assert.ok(Array.isArray(records) && (Array.isArray(data) || data.schemaVersion === schema),'Unsupported ledger schema');
    const statuses = {};
    for (const record of records) statuses[record.status] = (statuses[record.status] || 0)+1;
    stores[name] = {schemaVersion:Array.isArray(data)?'legacy':data.schemaVersion,count:records.length,statuses};
    if (schema === 2) stores[name].nonterminalRecords = records
      .filter((r)=>['reserved','processing','submission_unknown'].includes(r.status))
      .map((r)=>({keyHash:sha(String(r.idempotencyKey)),recordHash:sha(JSON.stringify(r)),
        status:r.status,createdAt:r.createdAt,updatedAt:r.updatedAt,hasHistoryId:!!r.historyId}))
      .sort((a,b)=>a.keyHash.localeCompare(b.keyHash));
  }
  return { files:files.length, bytes:files.reduce((n,f)=>n+(f.size||0),0),
    contentHash:sha(JSON.stringify(files.map(({path,type,size,sha256})=>({path,type,size,sha256})))),
    metadataHash:sha(JSON.stringify(files)),
    permissionsCompatible:files.every((f)=>f.uid===1000 && f.gid===1000 && (f.type==='directory' ? (f.mode & 0o700)===0o700 : f.mode===0o600)),stores };
}
const action = process.argv[2];
try {
  const before = scan();
  const initial = report(before); // Fail closed on unreadable/corrupt ledgers before writes.
  if (action === 'inspect') console.log(JSON.stringify(initial));
  else if (action === 'probe') {
    assert.equal(process.getuid(),1000); assert.equal(process.getgid(),1000);
    const file = path.join(root,'.deployment-probe-'+crypto.randomUUID());
    let moved = false;
    try {
      const fd = fs.openSync(file,'wx',0o600);
      try { fs.writeFileSync(fd,'probe'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(file,file+'.renamed'); moved=true;
      assert.equal(fs.readFileSync(file+'.renamed','utf8'),'probe');
    } finally { fs.unlinkSync(moved?file+'.renamed':file); }
    console.log(JSON.stringify({ok:true,uid:process.getuid(),gid:process.getgid(),...initial}));
  } else if (action === 'migrate') {
    assert.equal(process.getuid(),0);
    if (!initial.permissionsCompatible) for (const f of before) {
      const full=path.join(root,f.path);
      if(f.uid!==1000 || f.gid!==1000) fs.chownSync(full,1000,1000);
      // Only incompatible entries change. Never world-writable permissions.
      if (f.type==='file' && f.mode!==0o600) fs.chmodSync(full,0o600);
      if (f.type==='directory' && (f.mode & 0o700)!==0o700) fs.chmodSync(full,0o700);
    }
    const after=report(scan()); assert.equal(after.contentHash,initial.contentHash);
    assert.ok(after.permissionsCompatible);
    console.log(JSON.stringify({changed:!initial.permissionsCompatible,...after}));
  } else if (action === 'backup') {
    assert.equal(process.getuid(),0);
    assert.ok(!fs.existsSync('/backup/data.tar.gz') && !fs.existsSync('/backup/manifest.json'));
    fs.writeFileSync('/backup/manifest.json',JSON.stringify(before),{flag:'wx',mode:0o600});
    execFileSync('tar',['-czpf','/backup/data.tar.gz','-C',root,'.']);
    fs.chmodSync('/backup/data.tar.gz',0o600);
    assert.equal(report(scan()).metadataHash,initial.metadataHash,'Volume changed during backup');
    console.log(JSON.stringify({archiveSha256:sha(fs.readFileSync('/backup/data.tar.gz')),...initial}));
  } else if (action === 'restore') {
    assert.equal(process.getuid(),0);
    assert.equal(before.length,1,'Restore target must be a new empty isolated volume');
    assert.match(process.argv[3] || '',/^[a-f0-9]{64}$/);
    assert.equal(sha(fs.readFileSync('/backup/data.tar.gz')),process.argv[3],'Archive identity changed');
    const manifest=JSON.parse(fs.readFileSync('/backup/manifest.json','utf8'));
    for (const f of manifest) assert.ok(typeof f.path==='string' && !f.path.startsWith('/') && !f.path.includes('\\') && !f.path.split('/').includes('..') && ['file','directory'].includes(f.type));
    execFileSync('tar',['-xzpf','/backup/data.tar.gz','--same-owner','-C',root]);
    assert.deepEqual(scan(),manifest,'Restored content or permission mismatch');
    console.log(JSON.stringify({ok:true,...report(scan())}));
  } else throw new Error('Unknown volume action');
} catch {
  // Storage errors may contain media paths or ledger contents; never echo them.
  console.error('Jimeng storage check failed; preserve the volume and operation journal');
  process.exitCode=1;
}
