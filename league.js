const M = require('./engine');

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
 qipai(shan=new M.Shan(this._rule)){
  this.walls.push(shan.snapshot());
  this.effects=[];
  this.roundStart={points:[...this.model.defen],sticks:this.model.lizhibang};
  super.qipai(shan);
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
module.exports={LeagueGame,settle};


