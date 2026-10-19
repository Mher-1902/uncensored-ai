// Private maintenance only. No HTTP route, scheduler activation or schema change.
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {databaseOptions} from '../cloud/vercel-gateway/account-store.mjs';

const require=createRequire(new URL('../cloud/vercel-gateway/package.json',import.meta.url));
const roleCheck=`SELECT current_user AS name,
  NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
  AND pg_has_role(current_user,'offscript_gateway','MEMBER')
  AND NOT pg_has_role(current_user,'offscript_data_owner','MEMBER') AS restricted,
  has_function_privilege(current_user,'offscript_api.prune_metadata()','EXECUTE') AS can_prune
  FROM pg_roles r WHERE r.rolname=current_user`;

export function maintenanceMode(args){
  if(args.length===0 || args.length===1&&args[0]==='--check')return 'check';
  if(args.length===1&&args[0]==='--apply')return 'apply';
  throw Error('Use no arguments, --check, or --apply. Connection values belong in private environment configuration.');
}

export async function pruneMetadata({mode='check',env=process.env,poolFactory}={}){
  if(!['check','apply'].includes(mode))throw Error('Invalid retention mode.');
  let options;
  try {options=databaseOptions(env);}
  catch {throw Error('A valid restricted maintenance connection is not configured. No database operation was attempted.');}
  // Configuration validation is deliberately offline: no dependency loading,
  // DNS, connection, role query, cleanup or credential prompt occurs here.
  if(mode==='check')return {mode:'check',configurationValid:true,databaseContacted:false,applied:false};
  let pool;
  try {
    const make=poolFactory||((config)=>new (require('pg').Pool)(config));
    pool=await make({...options,max:1});
    pool.on('error',()=>{});
    const {rows}=await pool.query(roleCheck);
    if(rows.length!==1 || rows[0].name!=='offscript_runtime' || rows[0].restricted!==true || rows[0].can_prune!==true)throw Error();
    // Existing SECURITY DEFINER function owns retention rules. This command
    // never reads private rows, constructs SQL, or reconciles uncertain work.
    await pool.query('SELECT offscript_api.prune_metadata()');
    return {mode:'apply',databaseContacted:true,applied:true};
  } catch {
    throw Error('Metadata retention failed. Check the restricted connection and permissions; no database diagnostics were printed.');
  } finally {
    if(pool)await pool.end().catch(()=>{});
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {console.log(JSON.stringify(await pruneMetadata({mode:maintenanceMode(process.argv.slice(2))})));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
