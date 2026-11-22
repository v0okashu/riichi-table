const assert=require('node:assert/strict');
(async()=>{
const api=async(body)=>{const r=await fetch('http://localhost:8787/api',{method:'POST',body:JSON.stringify(body)});const d=await r.json();assert(!d.error,d.error);return d};
const host=await api({op:'create',name:'A'}),seats=[host];
for(const name of ['B','C','D'])seats.push(await api({op:'join',code:host.code,name}));
const send=(s,op,x)=>api({code:s.code,token:s.token,op,...x});
await send(host,'start');let steps=0,rounds=new Set(),deadline=Date.now()+120000;
while(Date.now()<deadline){const states=await Promise.all(seats.map(s=>send(s,'state')));if(states[0].final){console.log({steps,rounds:[...rounds],final:states[0].final});return}
for(const s of states){if(s.table){rounds.add(s.table.round);assert(!s.table.players.some(p=>p.hand));assert.equal(s.table.players[s.table.l].name,s.names[s.id])}
if(s.nonce){const best=s.options.findIndex(x=>['荣和','自摸'].includes(x)||x.startsWith('立直'));await send(s,'act',{nonce:s.nonce,i:best<0?s.options.length-1:best});steps++}}
await new Promise(r=>setTimeout(r,5))}
throw Error('timeout')})().catch(e=>{console.error(e);process.exitCode=1})
