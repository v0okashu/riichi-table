const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('./engine');
const { LeagueGame } = require('./league');
const ComputerPlayer = require('@kobalab/majiang-ai');
const rooms = new Map();
const rule = M.rule({'順位点':['50.0','10.0','-10.0','-30.0'],'連風牌は2符':true,'途中流局あり':false,'流し満貫あり':false,'ノーテン宣言あり':true,'最大同時和了数':1,'トビ終了あり':false,'オーラス止めあり':false,'延長戦方式':0,'カンドラ後乗せ':false,'ツモ番なしリーチあり':true,'リーチ後暗槓許可レベル':1,'ダブル役満あり':false,'数え役満あり':false,'切り上げ満貫あり':true});
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
function start(r){
 while(r.seats.length<4)r.seats.push({name:'电脑 '+winds[r.seats.length]});
 const bots=r.seats.map(s=>s.token?null:new ComputerPlayer());
 const players=r.seats.map((s,id)=>({action(msg,cb){
  const g=r.game, l=g.model.player_id.indexOf(id), type=Object.keys(msg)[0];
  if(id===0 && ['dapai','fulou','gang','hule'].includes(type)){
   const move=msg[type], digits=move.m?.replace(/[^0-9]/g,'').replace(/0/g,'5');
   const kind=type==='fulou'?(digits.length===4?'杠':digits[0]===digits[1]?'碰':'吃'):type==='gang'?'杠':type==='hule'?(move.baojia==null?'自摸':'荣和'):type;
   g.record(kind,move.l);
  }
  if(type==='qipai')r.result=null;
  if(type==='hule'||type==='pingju')r.result={...msg[type],chomboSeat:g.chomboSeat};
  if(type==='jieju')r.final=g.leagueResult.points;
  if(type==='drawReveal' && bots[id]){
   const show=M.Game.allow_no_daopai(rule,g.model.shoupai[l],g.model.shan.paishu);
   return cb(show?{daopai:'-'}:{});
  }
  if(bots[id]){
   const hasDecision=cb && choices(g,l,type).length>0;
   const readyAt=Date.now()+(hasDecision?crypto.randomInt(1000,5001):0);
   return bots[id].action(msg,cb && (reply=>{
    if(hasDecision)setTimeout(()=>cb(reply||{}),Math.max(0,readyAt-Date.now()));
    else cb(reply||{});
   }));
  }
  if(!cb)return;
  const options=choices(g,l,type);
  if(!options.length)return cb({});
  if(options.length===1 && options[0].label==='继续摸切')return setTimeout(()=>cb(options[0].reply),450);
  s.pending={nonce:crypto.randomUUID(),options,cb};
 }}));
 r.game=new LeagueGame(players,()=>{},rule,'雀庭');r.game.model.player=r.seats.map(s=>s.name);r.game.speed=0;r.game.kaiju();
}
function state(r,s){
 const id=r.seats.indexOf(s),g=r.game,m=g?.model,l=m?.player_id.indexOf(id);
 const local=require('node:os').networkInterfaces(); const lan=Object.values(local).flat().find(a=>a?.family==='IPv4'&&!a.internal&&/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)); return {lan:lan?.address,code:r.code,id,names:r.seats.map(x=>x.name),started:!!g,final:r.final,result:r.result,
 table:m?.shan && {l,drawReveal:g._status==='drawReveal',effects:g.effects,round:winds[Math.min(1,m.zhuangfeng)]+(m.zhuangfeng>1?4:m.jushu+1)+'局',honba:m.changbang,sticks:m.lizhibang,left:m.shan.paishu,dora:m.shan.baopai,rinshan:m.shan.rinshanRemaining,turn:m.lunban,hand:m.shoupai[l].toString().split(',')[0],players:m.player_id.map((i,j)=>({name:r.seats[i].name,count:(m.shoupai[j].toString().split(',')[0].match(/[0-9]/g)||[]).length,score:m.defen[i],river:m.he[j]._pai,melds:m.shoupai[j]._fulou}))},
 nonce:s.pending?.nonce,options:s.pending?.options.map(o=>o.label)||[]};
}
const page=fs.readFileSync(path.join(__dirname,'index.html')); const tilesScript=fs.readFileSync(path.join(__dirname,'tiles.js'));
http.createServer(async(req,res)=>{
 try{
 if(req.method==='GET'&&req.url==='/tiles.glb'){
  const zipped=/\bgzip\b/.test(req.headers['accept-encoding']||'');
  res.setHeader('Content-Type','model/gltf-binary');res.setHeader('Vary','Accept-Encoding');
  if(zipped)res.setHeader('Content-Encoding','gzip');
  return fs.createReadStream(path.join(__dirname,zipped?'tiles.glb.gz':'tiles.glb')).pipe(res);
 }
 if(req.method==='GET'&&req.url==='/meshes.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(__dirname,'meshes.js')))}
 if(req.method==='GET'&&['/faces.png','/table.css'].includes(req.url)){
  res.setHeader('Content-Type',req.url.endsWith('.png')?'image/png':'text/css;charset=utf-8');
  return res.end(fs.readFileSync(path.join(__dirname,req.url.slice(1))));
 }
 if(req.method==='GET'&&req.url==='/tiles.js'){res.setHeader('Content-Type','text/javascript;charset=utf-8');return res.end(tilesScript)}
 if(req.method==='GET'&&req.url.split('?')[0]==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(page)}
 if(req.method!=='POST'||req.url!=='/api'){res.writeHead(404);return res.end()}
 let body='';for await(const part of req){body+=part;if(body.length>4000)throw Error('请求过长')}
 const b=JSON.parse(body);let r=rooms.get(b.code),s;
 if(b.op==='create'){let code;do{code=crypto.randomInt(100000,1000000).toString()}while(rooms.has(code));r={code,seats:[]};rooms.set(code,r)}
 if(!r)throw Error('找不到房间');
 if(['create','join'].includes(b.op)){
 if(r.game||r.seats.length===4)throw Error('房间已开局或已满');
 s={name:String(b.name||'雀士').trim().slice(0,12)||'雀士',token:crypto.randomUUID()};r.seats.push(s);
 }else{
 s=r.seats.find(x=>x.token&&x.token===b.token);if(!s)throw Error('座位凭证失效');
 if(b.op==='start'){if(s!==r.seats[0]||r.game)throw Error('只有房主能开局');start(r)}
 if(b.op==='act'){
  const p=s.pending;
  if(!p||p.nonce!==b.nonce||!Number.isInteger(b.i)||!p.options[b.i])throw Error('操作已过期');
  const action=p.options[b.i].reply;
  if(action.beginRiichi){
   const g=r.game;
   const options=g.get_dapai().map(tile=>({label:'宣言 '+tile,reply:g.allow_lizhi(tile)?{dapai:tile+'*'}:{chombo:true}}));
   s.pending={...p,nonce:crypto.randomUUID(),options};
  }else{
   s.pending=null;
   p.cb(action);
  }
 }










 }
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...state(r,s),token:s.token}));
 }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}))}
}).listen(Number(process.env.PORT)||8787,'0.0.0.0');

