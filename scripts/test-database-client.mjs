// Private disposable-fixture client. No URL, host, database or real credential input.
import pg from '../cloud/vercel-gateway/node_modules/pg/lib/index.js';
if(process.env.OFFSCRIPT_TEST_FIXTURE!=='disposable-postgres'||!['postgres','project_migrator'].includes(process.argv[2]))throw Error('Not a disposable fixture');
let sql='';for await(const part of process.stdin){sql+=part;if(sql.length>100000)throw Error('Fixture input too large')}
const client=new pg.Client({host:'127.0.0.1',port:5432,database:'offscript_test',user:process.argv[2],password:'disposable-test-only',ssl:false,connectionTimeoutMillis:5000,statement_timeout:10000});
try{
 await client.connect();
 const result=await client.query(sql);
 for(const item of Array.isArray(result)?result:[result])for(const row of item.rows||[])console.log(Object.values(row).map(v=>v===null?'':typeof v==='boolean'?v?'t':'f':typeof v==='object'?JSON.stringify(v):String(v)).join('|'));
}catch(error){console.error(error.message);process.exitCode=1}finally{await client.end()}
