import path from 'node:path';
import { build, deploy, inspect, json, profile, rollback, verify } from './jimeng-deploy-lib.mjs';

const [command,...args] = process.argv.slice(2);
const options = {};
for (const arg of args) {
  const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
  if (!match || Object.hasOwn(options,match[1])) throw new Error('Use unique --name=value options');
  options[match[1]] = match[2] ?? true;
}
const allowed = ['state-dir','record','rc','dry-run','profile','container','volume','execute','expected-image','handoff','maintenance-file','allow-permission-migration','journal'];
for (const name of Object.keys(options)) if (!allowed.includes(name)) throw new Error(`Unknown option: ${name}`);
for (const name of ['dry-run','execute','handoff','allow-permission-migration']) {
  if (options[name] !== undefined && options[name] !== true) throw new Error(`Use --${name} without a value`);
}
const selected = profile(options.profile);
let result;
if (command === 'build') {
  const stateDir = options['state-dir'] || process.env.JIMENG_BUILD_STATE_DIR;
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new Error('An absolute external --state-dir is required');
  result = await build({stateDir,rc:Number(options.rc ?? 3),dryRun:options['dry-run'] === true});
} else if (command === 'inspect') {
  result = await inspect({container:options.container || selected.container,volume:options.volume});
} else if (command === 'verify') {
  if (typeof options.record !== 'string') throw new Error('--record is required');
  result = await verify({record:await json(options.record),container:options.container || selected.container,volume:options.volume,selected});
} else if (['install','upgrade'].includes(command)) {
  if (typeof options.record !== 'string') throw new Error('--record is required');
  result = await deploy({action:command,record:await json(options.record),container:options.container,
    volume:options.volume,selected,stateDir:options['state-dir'],expectedImage:options['expected-image'],
    handoff:options.handoff === true,dryRun:options['dry-run'] === true || options.execute !== true,
    execute:options.execute === true,maintenanceFile:options['maintenance-file'],allowPermissionMigration:options['allow-permission-migration'] === true});
} else if(command==='rollback') {
  result=await rollback({journalFile:options.journal,record:await json(options.record),stateDir:options['state-dir'],
    execute:options.execute===true,dryRun:options['dry-run']===true || options.execute!==true,maintenanceFile:options['maintenance-file']});
} else throw new Error('Supported commands: build, inspect, install, upgrade, verify, rollback');
console.log(JSON.stringify(result,null,2));
