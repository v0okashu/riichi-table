const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const origin = process.argv[2] || 'http://localhost:8787';

async function request(body, cookie) {
 const headers = cookie ? {cookie} : {};
 const response = await fetch(origin+'/api', {method:'POST',headers,body:JSON.stringify(body)});
 return {data:await response.json(),status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function api(body,cookie) {
 const response=await request(body,cookie);
 assert.equal(response.status,200,response.data.error);
 return response.data;
}

async function verify() {
 assert.equal((await request({op:'create'})).status,401);
 const suffix=Date.now().toString(36);
 const seats=[];
 let code;
 for(const [index,nickname] of ['东测试','南测试','西测试','北测试'].entries()){
  const registration=await request({op:'register',username:'qa_'+suffix+'_'+index,password:'test-account-'+suffix,nickname});
  assert.equal(registration.status,200,registration.data.error);
  const {cookie}=registration;
  assert(cookie);
  const seat=await api({op:code?'join':'create',code},cookie);
  code=seat.code;
  seats.push({...seat,cookie});
 }
 const send=(seat,op,extra={})=>api({code,token:seat.token,op,...extra},seat.cookie);
 await send(seats[0],'start');
 assert.equal((await api({op:'me'},seats[0].cookie)).profile.recentCount,0);
 assert.deepEqual((await api({op:'history'},seats[0].cookie)).matches,[]);
 assert.equal((await request({op:'state',code,token:seats[0].token},seats[1].cookie)).status,400);
 assert.equal((await request({op:'replay',code,token:seats[0].token},seats[0].cookie)).status,400);
 const deadline=Date.now()+120000;
 let steps=0;
 while(Date.now()<deadline){
  const states=await Promise.all(seats.map(s=>send(s,'state')));
  if(states[0].final){
   for(const [i,seat] of seats.entries()){
    const result=states[0].final[i];
    const profile=(await api({op:'me'},seat.cookie)).profile;
    assert.equal(profile.recentCount,1);
    assert.equal(profile.recentPoints,result);
    const snapshot=await send(seat,'state');
    assert.deepEqual(snapshot.rankResult.profile,profile);
   }
   const replay=await send(seats[0],'replay');
   assert(replay.rounds.every(round=>round.wall.length===136));
   const nextDevice=await request({op:'login',username:'qa_'+suffix+'_0',password:'test-account-'+suffix});
   assert.equal(nextDevice.status,200);
   assert.notEqual(nextDevice.cookie,seats[0].cookie);
   const saved=(await api({op:'history'},nextDevice.cookie)).matches;
   assert.equal(saved.length,1);
   assert.equal(saved[0].id,replay.id);
   assert.equal(saved[0].roundCount,replay.rounds.length);
   assert.equal(saved[0].rounds,undefined);
   const playback=await api({op:'savedReplay',matchId:replay.id},nextDevice.cookie);
   assert.deepEqual(playback,replay);
   const stranger=await request({op:'register',username:'qa_'+suffix+'_x',password:'test-account-'+suffix,nickname:'游客测试'});
   assert.equal((await request({op:'savedReplay',matchId:replay.id},stranger.cookie)).status,404);
   const returned=await Promise.all(seats.slice(0,3).map(seat=>send(seat,'returnRoom',{matchId:replay.id})));
   for(const [i,room] of returned.entries()){
    assert.equal(room.code,code);
    assert.equal(room.id,i);
    assert.equal(room.token,seats[i].token);
    assert.equal(room.started,false);
    assert.equal(room.final,undefined);
    assert.deepEqual(room.names,states[0].names);
   }
   assert.deepEqual((await send(seats[3],'state')).final,states[0].final);
   assert.equal((await request({op:'start',code,token:seats[1].token},seats[1].cookie)).status,400);
   await send(seats[0],'start');
   for(const [i,seat] of seats.entries()){
    const next=await send(seat,'state');
    assert.equal(next.code,code);
    assert.equal(next.id,i);
    assert.equal(next.started,true);
    assert.equal(next.final,undefined);
    assert(next.matchId);
    assert.notEqual(next.matchId,replay.id);
   }
   console.log('完整半庄、账号隔离、段位结算、136 张回放及原房间再开局通过', {steps,rounds:replay.rounds.length});
   return;
  }
  for(const [i,state] of states.entries()){
   if(state.table)assert(!state.table.players.some(p=>p.hand));
   if(!state.nonce)continue;
   const preference=state.options.findIndex(x=>['荣和','自摸','公开听牌'].includes(x));
   const discard=state.options.findIndex(x=>x.startsWith('打 '));
   await send(seats[i],'act',{nonce:state.nonce,i:preference>=0?preference:discard>=0?discard:state.options.length-1});
   steps++;
  }
  await delay(5);
 }
 throw Error('对局测试超时');
}
verify().catch(error=>{console.error(error); process.exitCode=1});
