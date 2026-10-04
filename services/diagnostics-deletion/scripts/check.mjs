import {readdir} from 'node:fs/promises';import {spawnSync} from 'node:child_process';
for(const dir of ['src','tests'])for(const file of await readdir(dir))if(file.endsWith('.mjs')){const result=spawnSync(process.execPath,['--check',`${dir}/${file}`],{stdio:'inherit'});if(result.status)process.exit(result.status);}
console.log('PASS module syntax. Cloudflare runtime and deployment were not executed.');
