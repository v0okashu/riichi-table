const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {networkInterfaces} = require('node:os');
const M = require('./engine');
const { LeagueGame, leagueRule:rule } = require('./league');
const { drillRequest } = require('./drills');
const { buildReplay } = require('./replay-data');
const ComputerPlayer = require('@kobalab/majiang-ai');
const { openAccounts, sessionLifetime, rankRules } = require('./accounts');
const { openRoomStore } = require('./room-store');
const dataDir=process.env.RIICHI_DATA_DIR||path.join(__dirname,'data');
const accounts=openAccounts(path.join(dataDir,'accounts.sqlite'));
const rooms = new Map();
const desktopLan=process.argv.includes('--desktop-lan');
const desktopMode=desktopLan||process.argv.includes('--desktop');
const roomStore=desktopMode?openRoomStore(path.join(dataDir,'rooms.sqlite')):null;
const listenHost=process.env.RIICHI_HOST||'0.0.0.0';
const localInvites=!desktopMode&&listenHost==='0.0.0.0'&&process.env.NODE_ENV!=='production';
const roomAlphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// The order and sizes also define the decoder in desktop/NetworkMenu.cs.
const groupRanges=[
 [0x0a000000,0x01000000], // 10.0.0.0/8
 [0xac100000,0x00100000], // 172.16.0.0/12
 [0xc0a80000,0x00010000], // 192.168.0.0/16
 [0x64400000,0x00400000], // 100.64.0.0/10
];

function groupAddressIndex(ip){
 const address=ip.split('.').reduce((value,octet)=>value*256+Number(octet),0);
 let offset=0;
 for(const [start,size] of groupRanges){
  if(address>=start&&address<start+size)return offset+address-start;
  offset+=size;
 }
}

const desktopControl=desktopMode&&!desktopLan&&process.env.RIICHI_DESKTOP_CONTROL;
let groupAddress=desktopLan?listenHost:null;
let groupHostIndex=groupAddress?groupAddressIndex(groupAddress):undefined;
let groupListener,openingGroup=false;

function availableGroupHost(address){
 return typeof address==='string'&&Object.values(networkInterfaces()).flat()
  .some(item=>item?.family==='IPv4'&&!item.internal&&item.address===address)&&groupAddressIndex(address)!==undefined;
}

async function openGroup(address){
 if(!availableGroupHost(address))throw Error('组网地址已不可用，请刷新网卡列表。');
 if(address===groupAddress)return;
 if([...rooms.values()].some(r=>r.address&&r.address!==address))
  throw Error('当前牌桌仍在使用原组网网卡，请先解散牌桌。');
 if(openingGroup)throw Error('正在开启组网，请稍候。');
 const listener=http.createServer(handleRequest);
 openingGroup=true;
 try{
  await new Promise((resolve,reject)=>{
   listener.once('error',reject);
   listener.listen(8787,address,resolve);
  });
  groupListener?.close();
  groupListener=listener;
  groupAddress=address;
  groupHostIndex=groupAddressIndex(address);
 }catch(error){
  if(error.code==='EADDRINUSE')throw Error('组网端口 8787 已被占用。请关闭其他牌桌后重试。');
  throw error;
 }finally{openingGroup=false;}
}

function groupRoomCode(code){
 if(groupHostIndex===undefined)return undefined;
 let value=groupHostIndex*900000+Number(code)-100000;
 let encoded='';
 for(let i=0;i<9;i++){
  encoded=roomAlphabet[value%32]+encoded;
  value=Math.floor(value/32);
 }
 return encoded.slice(0,3)+'-'+encoded.slice(3,6)+'-'+encoded.slice(6);
}

function requestToken(req) {
 return req.headers.cookie?.match(/(?:^|;\s*)riichi_session=([0-9a-f]{64})(?=;|$)/)?.[1];
}
function sessionCookie(req, res, token, maxAge) {
 const secure = req.socket.encrypted || req.headers['x-forwarded-proto']==='https';
 res.setHeader('Set-Cookie','riichi_session='+token+'; Path=/; Max-Age='+maxAge+'; HttpOnly; SameSite=Strict'+(secure?'; Secure':''));
}
function applyRankResults(room) {
 if(room.ranks)return;
 const accountIds=room.seats.map(seat=>seat.accountId??null);
 const participants=accountIds.flatMap((id,index)=>id?[{id,points:room.final[index]}]:[]);
 const ranks=accounts.applyMatch(room.completed.id,participants,{
  ...room.completed,accountIds,final:room.final,walls:room.game.walls
 });
 const seats=room.seats.filter(seat=>seat.accountId);
 if(room.address)roomStore.finish({...room,seats});
 room.finalNames=room.seats.map(seat=>seat.name);
 room.seats=seats;
 room.matchId=null;
 room.dealer=null;
 room.ranks=ranks;
}
function sendSavedReplay(res,accountId,matchId){
 const match=typeof matchId==='string' && accounts.savedMatch(accountId,matchId);
 if(!match){
  res.statusCode=404;
  return res.end(JSON.stringify({error:'找不到这份牌谱'}));
 }
 const {record,walls,...summary}=match;
 return res.end(JSON.stringify({...summary,rounds:buildReplay(record,walls)}));
}

const winds='东南西北';
function choices(g,l,type){
 const own=l===g.model.lunban, list=[];
 const add=(label,reply)=>list.push({label,reply});
 if(own && (['zimo','gangzimo'].includes(type)||type==='fulou'&&!g._gang)){
  if(type!=='fulou'){
   if(g.allow_hule()) add('自摸',{hule:'-'});
   for(const m of g.get_gang_mianzi()||[]) add('杠 '+m,{gang:m});
   if(g.model.shan.paishu && g.allow_lizhi())add('立直',{beginRiichi:true});
  }
  for(const p of g.get_dapai()){
   const locked=g.model.shoupai[l].lizhi;
   add(locked?'继续摸切':'打 '+p,{dapai:p});
  }
 }
 if(!own && (type==='dapai'||type==='gang'&&!/^.[0-9]{4}$/.test(g._gang))){
  if(g.allow_hule(l)) add('荣和',{hule:'-'});
  if(type==='dapai'){
   for(const [label,fn] of [['吃','get_chi_mianzi'],['碰','get_peng_mianzi'],['杠','get_gang_mianzi']])
    for(const m of g[fn](l)||[]) add(label+' '+m,{fulou:m});
  }
  if(list.length)add('过',{});
 }
 if(type==='drawReveal' && M.Game.allow_no_daopai(rule,g.model.shoupai[l],g.model.shan.paishu)){
  add('公开听牌',{daopai:'-'});
  add('盖牌（按未听牌结算）',{});
 }
 if(['hule','pingju'].includes(type))add('继续', {});
 return list;
}
function declaration(g){
 return g.get_dapai().map(tile=>({label:'宣言 '+tile,reply:g.allow_lizhi(tile)?{dapai:tile+'*'}:{chombo:true}}));
}
function start(r,events){
 const restoring=events!==undefined;
 const steps=[],walls=[],inputs=new Map();
 for(const [kind,data] of events??[]){
  if(kind==='wall')walls.push(data);
  else if(kind==='input')inputs.set(...data);
  else if(kind==='step'){steps.push(data);inputs.clear();}
 }
 if(!restoring){
  const dealer=crypto.randomInt(4),matchId=crypto.randomUUID();
  const seats=r.seats.slice();
  while(seats.length<4)seats.push({name:'电脑 '+winds[seats.length]});
  if(r.address)roomStore.save({...r,dealer,matchId,seats});
  Object.assign(r,{dealer,matchId,seats});
  r.completed=r.final=r.finalNames=r.ranks=r.result=null;
  for(const seat of seats)seat.pending=null;
 }
 const bots=r.seats.map(s=>s.token?null:new ComputerPlayer());
 const players=r.seats.map((s,id)=>({action(msg,cb){
  if(r.closed||r.game!==g)return;
  const l=g.model.player_id.indexOf(id), type=Object.keys(msg)[0];
  if(id===0 && ['dapai','fulou','gang','hule'].includes(type)){
   const move=msg[type], digits=move.m?.replace(/[^0-9]/g,'').replace(/0/g,'5');
   const kind=type==='fulou'?(digits.length===4?'杠':digits[0]===digits[1]?'碰':'吃'):type==='gang'?'杠':type==='hule'?(move.baojia==null?'自摸':'荣和'):type;
   g.record(kind,move.l);
  }
  if(type==='qipai')r.result=null;
  if(type==='hule'||type==='pingju')r.result={...msg[type],chomboSeat:g.chomboSeat};
  if(type==='jieju'&&!r.final){
   r.completed={id:r.matchId,at:new Date().toISOString(),record:msg.jieju};
   r.final=g.leagueResult.points;
   try{applyRankResults(r)}catch(error){console.error('保存段位结果失败',error.message);}
  }
  if(g.replaying){
   if(bots[id]&&type!=='drawReveal')bots[id].action(msg);
   return;
  }
  if(type==='drawReveal' && bots[id]){
   const show=M.Game.allow_no_daopai(rule,g.model.shoupai[l],g.model.shan.paishu);
   return cb(show?{daopai:'-'}:{});
  }
  if(bots[id]){
   const hasDecision=cb && choices(g,l,type).length>0;
   const readyAt=Date.now()+(hasDecision?crypto.randomInt(1000,3001):0);
   return bots[id].action(msg,cb && (reply=>{
    if(hasDecision)setTimeout(()=>{if(!r.closed)cb(reply||{})},Math.max(0,readyAt-Date.now()));
    else cb(reply||{});
   }));
  }
  if(!cb)return;
  const input=inputs.get(id);
  inputs.delete(id);
  if(input&&!input.beginRiichi)return cb(input);
  const options=input?.beginRiichi?declaration(g):choices(g,l,type);
  if(!options.length)return cb({});
  if(options.length===1 && options[0].label==='继续摸切')return setTimeout(()=>{if(!r.closed)cb(options[0].reply)},450);
  s.pending={nonce:crypto.randomUUID(),options,cb};
 }}));
 const g=r.game=new LeagueGame(players,()=>{},rule,'汪汪队');
 g.model.player=r.seats.map(s=>s.name);
 g.speed=0;
 if(r.address){
  g.saveWall=wall=>{if(!r.closed)roomStore.append(r.code,'wall',wall);};
  g.saveStep=(status,replies)=>{if(!r.closed)roomStore.append(r.code,'step',[status,replies]);};
 }
 if(restoring)g.restore(r.dealer,steps,walls);
 else g.kaiju(r.dealer);
}
function closeRoom(r){
 if(r.address)roomStore.remove(r.code);
 r.closed=true;
 r.game?.stop();
 rooms.delete(r.code);
}
function activeLanRoom(accountId){
 return [...rooms.values()].findLast(room=>room.address
  &&room.seats.some(seat=>seat.accountId===accountId));
}
function state(r,s){
 if(r.completed)applyRankResults(r);
 const id=r.seats.indexOf(s),g=r.final?null:r.game,m=g?.model,l=m?.player_id.indexOf(id);
 const rankResult=r.ranks?.[s.accountId],replayId=rankResult?r.completed.id:undefined;
 const final=rankResult&&s.returnedFrom!==replayId?r.final:undefined;
 const lan=localInvites?Object.values(networkInterfaces()).flat().find(a=>a?.family==='IPv4'&&!a.internal&&/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))?.address:undefined;
 return {lan,code:r.code,groupCode:r.groupCode,practice:Boolean(r.practice),id,names:final?r.finalNames:r.seats.map(x=>x.name),started:!!g,matchId:r.matchId??undefined,final,rankResult,replayId,result:g?r.result:undefined,
 table:m?.shan && {l,handNumber:g.walls.length,drawReveal:g._status==='drawReveal',effects:g.effects,round:winds[Math.min(1,m.zhuangfeng)]+(m.zhuangfeng>1?4:m.jushu+1)+'局',honba:m.changbang,sticks:m.lizhibang,left:m.shan.paishu,dora:m.shan.baopai,rinshan:m.shan.rinshanRemaining,turn:m.lunban,hand:m.shoupai[l].toString().split(',')[0],players:m.player_id.map((i,j)=>({name:r.seats[i].name,count:(m.shoupai[j].toString().split(',')[0].match(/[0-9]/g)||[]).length,score:m.defen[i],river:m.he[j]._pai,melds:m.shoupai[j]._fulou}))},
 nonce:g?s.pending?.nonce:undefined,options:g?s.pending?.options.map(o=>o.label)||[]:[]};
}
const page=fs.readFileSync(path.join(__dirname,'index.html')); const tilesScript=fs.readFileSync(path.join(__dirname,'tiles.js'));
async function handleRequest(req,res){
 try{
 const desktopHome=Boolean(desktopControl)&&req.socket.localAddress==='127.0.0.1';
 if(req.method==='GET'&&req.url==='/health'){
  res.writeHead(204,{'X-WangWang-Server':'riichi-table','Cache-Control':'no-store'});
  return res.end();
 }
 if(req.method==='GET'&&req.url==='/tiles.glb'){
  const zipped=/\bgzip\b/.test(req.headers['accept-encoding']||'');
  res.setHeader('Content-Type','model/gltf-binary');res.setHeader('Vary','Accept-Encoding');
  if(zipped)res.setHeader('Content-Encoding','gzip');
  return fs.createReadStream(path.join(__dirname,zipped?'tiles.glb.gz':'tiles.glb')).pipe(res);
 }
 if(req.method==='GET'&&['/meshes.js','/replay.js','/account-ui.js','/drill-ui.js'].includes(req.url)){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(__dirname,req.url.slice(1))))}
 if(req.method==='GET'&&req.url==='/author-payment.jpg'){
  res.setHeader('Content-Type','image/jpeg');
  return res.end(fs.readFileSync(path.join(__dirname,'author-payment.jpg')));
 }
 if(req.method==='GET'&&['/faces.png','/table.css'].includes(req.url)){
  res.setHeader('Content-Type',req.url.endsWith('.png')?'image/png':'text/css;charset=utf-8');
  return res.end(fs.readFileSync(path.join(__dirname,req.url.slice(1))));
 }
 if(req.method==='GET'&&req.url==='/tiles.js'){res.setHeader('Content-Type','text/javascript;charset=utf-8');return res.end(tilesScript)}
 if(req.method==='GET'&&req.url.split('?')[0]==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(page)}
 if(req.method!=='POST'||req.url!=='/api'){res.writeHead(404);return res.end()}
 let body='';for await(const part of req){body+=part;if(body.length>4000)throw Error('请求过长')}
 const b=JSON.parse(body);
 if(b.op==='desktopNetwork'){
  if(!desktopHome||req.headers.authorization!=='Bearer '+desktopControl){
   res.writeHead(404);return res.end();
  }
  await openGroup(b.address);
  res.writeHead(204);
  return res.end();
 }
 const loginToken=requestToken(req);
 res.setHeader('Content-Type','application/json');
 res.setHeader('Cache-Control','no-store');
 if(['register','login'].includes(b.op)){
  const login=await accounts.authenticate(b.op,b);
  sessionCookie(req,res,login.token,sessionLifetime);
  return res.end(JSON.stringify({profile:login.profile,rankRules}));
 }
 if(b.op==='logout'){
  accounts.logout(loginToken);
  sessionCookie(req,res,'',0);
  return res.end('{}');
 }
 const accountId=accounts.accountId(loginToken);
 if(b.op==='me')return res.end(JSON.stringify(accountId?{profile:accounts.profile(accountId),rankRules,
  hasLanRoom:desktopHome&&Boolean(activeLanRoom(accountId))}:{profile:null}));
 if(!accountId){res.statusCode=401;return res.end(JSON.stringify({error:'请先登录'}));}

 if(['drillProgress','drillQuestion','drillAnswer'].includes(b.op))return res.end(JSON.stringify(drillRequest(accounts,accountId,b)));

 if(b.op==='leaderboard')return res.end(JSON.stringify({players:accounts.leaderboard(accountId)}));
 if(b.op==='history')return res.end(JSON.stringify({matches:accounts.matches(accountId)}));
 if(b.op==='savedReplay')return sendSavedReplay(res,accountId,b.matchId);

 const groupCode=b.op==='join'&&typeof b.code==='string'
  ?b.code.toUpperCase().replace(/[\s-]/g,'').replace(/O/g,'0').replace(/[IL]/g,'1'):'';
 let r=rooms.get(b.code),s;
 if(!r&&groupCode.length===9)r=[...rooms.values()].find(room=>room.groupCode?.replaceAll('-','')===groupCode);
 if(b.op==='resume'&&!b.code){
  const active=desktopHome&&activeLanRoom(accountId);
  if(!active)return res.end('{}');
  r=active;
 }
 if(b.op==='create'){
  let code;
  do{code=crypto.randomInt(100000,1000000).toString()}while(rooms.has(code));
  const practice=desktopHome&&b.practice===true;
  const address=practice?null:groupAddress;
  r={code,address,groupCode:address?groupRoomCode(code):undefined,practice,seats:[]};
 }
 function roomClosed(message){
  res.statusCode=404;
  return res.end(JSON.stringify({error:message}));
 }
 if(!r||(r.practice&&!desktopHome))return roomClosed('牌桌已解散或房间已失效');
 if(r.completed)applyRankResults(r);
 if(['create','join','resume'].includes(b.op)){
  s=r.seats.find(seat=>seat.accountId===accountId);
  if(!s){
   if(b.op==='resume')return roomClosed('找不到你的座位，请返回大厅');
   if((r.game&&!r.final)||r.seats.length===4)throw Error('房间已开局或已满');
   s={name:accounts.profile(accountId).nickname,accountId,token:crypto.randomUUID()};
   const seats=[...r.seats,s];
   if(r.address)roomStore.save({...r,seats});
   r.seats=seats;
   if(b.op==='create')rooms.set(r.code,r);
  }
 }else{
  s=r.seats.find(seat=>seat.accountId===accountId&&seat.token===b.token);
  if(!s){
   if(b.op==='state'){
    res.statusCode=400;
    return res.end(JSON.stringify({error:'座位凭证失效，请重新进入房间',seatLost:true}));
   }
   throw Error('座位凭证失效');
  }
 if(b.op==='leavePractice'||b.op==='dissolve'){
  if(s!==r.seats[0])throw Error('只有房主能解散牌桌');
  if(b.op==='leavePractice'?!r.practice:!r.address)throw Error('当前房间不支持此操作');
  closeRoom(r);
  return res.end(JSON.stringify({closed:true}));
 }
 if(b.op==='leaveRoom'){
  if(r.game&&!r.final)throw Error('请在半庄结束后离开房间');
  if(r.address&&s===r.seats[0])throw Error('房主可选择解散牌桌');
  const seats=r.seats.filter(seat=>seat!==s);
  if(!seats.length)closeRoom(r);
  else{
   if(r.address)roomStore.save({...r,seats});
   r.seats=seats;
  }
  return res.end(JSON.stringify({closed:true}));
 }
 if(b.op==='returnRoom'&&r.completed?.id===b.matchId)s.returnedFrom=b.matchId;
 if(b.op==='start'){
  if(s!==r.seats[0]||(r.game&&!r.final))throw Error('只有房主能开局');
  start(r);
 }
 if(b.op==='replay'){
  if(!r.completed)throw Error('半庄结束后才能查看牌谱');
  applyRankResults(r);
  return sendSavedReplay(res,accountId,r.completed.id);
 }
 if(b.op==='act'){
  const p=s.pending;
  if(!p||p.nonce!==b.nonce||!Number.isInteger(b.i)||!p.options[b.i])throw Error('操作已过期');
  const action=p.options[b.i].reply;
  if(r.address)roomStore.append(r.code,'input',[r.seats.indexOf(s),action]);
  if(action.beginRiichi){
   s.pending={...p,nonce:crypto.randomUUID(),options:declaration(r.game)};
  }else{
   s.pending=null;
   p.cb(action);
  }
 }
 }
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...state(r,s),token:s.token}));
 }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}))}
}

const gameServer=http.createServer(handleRequest);

if(desktopMode){
 const host=desktopLan?process.env.RIICHI_HOST:'127.0.0.1';
 if(desktopLan&&!availableGroupHost(host)){
  console.log('ERROR:EADDRNOTAVAIL');
  process.exit(1);
 }
 for(const {events,...room} of roomStore.load()){
  if(desktopLan&&room.address!==host)continue;
  try{
   if(room.matchId)start(room,events);
   rooms.set(room.code,room);
  }catch(error){
   room.closed=true;
   console.error('恢复组网牌桌失败',room.code,error.message);
  }
 }
 gameServer.once('error',error=>{
  console.log('ERROR:'+error.code);
  process.exitCode=1;
  process.stdin.pause();
 });
 gameServer.listen(desktopLan?8787:0,host,()=>{
  console.log('http://'+host+':'+gameServer.address().port+'/');
 });
 if(!desktopLan){
  const restoreListener=()=>{
   if(groupAddress||openingGroup)return;
   const address=[...rooms.values()].find(room=>room.address)?.address;
   if(address&&availableGroupHost(address))openGroup(address).catch(()=>{});
  };
  restoreListener();
  setInterval(restoreListener,3000).unref();
 }
 // The desktop host keeps the pipe open while its window is running.
 process.stdin.resume();
 process.stdin.once('end',()=>{
  groupListener?.close();
  gameServer.close(()=>process.exit(0));
 });
}else{
 gameServer.listen(Number(process.env.PORT)||8787,listenHost);
}
