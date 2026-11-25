const M = require('./engine');
const leagueRule = M.rule({'順位点':['50.0','10.0','-10.0','-30.0'],'連風牌は2符':true,'途中流局あり':false,'流し満貫あり':false,'ノーテン宣言あり':true,'最大同時和了数':1,'トビ終了あり':false,'オーラス止めあり':false,'延長戦方式':0,'カンドラ後乗せ':false,'ツモ番なしリーチあり':true,'リーチ後暗槓許可レベル':1,'ダブル役満あり':false,'数え役満あり':false,'切り上げ満貫あり':true});

// Use tenths of a league point so three-way tie rounding is deterministic.
function settle(scores, dealer, sticks) {
 const order=[0,1,2,3].map(i=>(dealer+i)%4).sort((a,b)=>scores[b]-scores[a]);
 const bonuses=[500,100,-100,-300], points=[], adjusted=[...scores];
 for(let start=0;start<4;){
  let end=start+1;
  while(end<4 && scores[order[end]]===scores[order[start]])end++;
  const count=end-start,total=bonuses.slice(start,end).reduce((a,b)=>a+b);
  const base=Math.floor(total/count);
  for(let i=start;i<end;i++){
   const id=order[i],offset=i-start;
   if(start===0)adjusted[id]+=sticks*(Math.floor(10/count)+(offset<10%count?1:0))*100;
   points[id]=((adjusted[id]-30000)/100+base+(offset<total-base*count?1:0))/10;
  }
  start=end;
 }
 return {points,adjusted};
}
class LeagueGame extends M.Game {
 effects=[];
 sequence=0;
 record(kind,seat){
  this.effects.push({seq:++this.sequence,kind,seat});
  if(this.effects.length>24)this.effects.shift();
 }
 penalties=[0,0,0,0];
 walls=[];
 qipai(shan){
  const savedWall=this.savedWalls?.[this.walls.length];
  if(this.replaying&&!savedWall)throw Error('无法恢复牌山');
  shan??=new M.Shan(this._rule,savedWall);
  const wall=shan.snapshot();
  if(!savedWall)this.saveWall?.(wall);
  this.walls.push(wall);
  this.effects=[];
  this.roundStart={points:[...this.model.defen],sticks:this.model.lizhibang};
  super.qipai(shan);
 }
 next(){
  if(!this._sync&&!this._stop&&this._status!=='jieju'&&this._reply.filter(Boolean).length===4)
   this.saveStep?.(this._status,this._reply);
  super.next();
 }
 delay(callback,timeout){
  if(this.restoredDelays)this.restoredDelays.push(callback);
  else super.delay(callback,timeout);
 }
 restore(dealer,steps,walls){
  this.savedWalls=walls;
  this.restoredDelays=[];
  this._sync=true;
  try{
   this.replaying=steps.length>0;
   this.kaiju(dealer);
   for(const [index,[status,replies]] of steps.entries()){
    if(this._status!==status)throw Error(`牌局进度不一致（第 ${index+1} 步，${this._status} / ${status}）`);
    this.replaying=index<steps.length-1;
    this._reply=replies;
    this.next();
    while(this.restoredDelays.length)this.restoredDelays.shift()();
   }
  }finally{
   this._sync=false;
   this.replaying=false;
   this.savedWalls=null;
   this.restoredDelays=null;
  }
  this._timeout_id=setTimeout(()=>this.next(),0);
 }
 reply_zimo(){
  const seat=this.model.lunban,reply=this.get_reply(seat);
  if(!reply.chombo)return super.reply_zimo();
  this.penalties[this.model.player_id[seat]]+=20;
  this.model.defen.splice(0,4,...this.roundStart.points);
  this.model.lizhibang=this.roundStart.sticks;
  this.chomboSeat=seat;
  this.pingju('诈立');
 }
 reply_pingju(){
  if(this.chomboSeat==null)return super.reply_pingju();
  this.chomboSeat=null;
  this.delay(()=>this.qipai(),0);
 }
 reply_dapai(){
  const before=this.model.lizhibang,seat=this.model.lunban;
  super.reply_dapai();
  if(this.model.lizhibang>before)this.record('stick',seat);
 }
 jieju(){
  this.leagueResult=settle(this.model.defen,this.model.qijia,this.model.lizhibang);
  this.leagueResult.points=this.leagueResult.points.map((points,id)=>points-this.penalties[id]);
  super.jieju();
 }
}
module.exports={LeagueGame,settle,leagueRule};


