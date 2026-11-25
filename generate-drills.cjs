const fs=require('node:fs');
const path=require('node:path');
const M=require('./engine');
const {analyze,tileCounts,tileTypes,modes}=require('./drills');

let seed=0x715e2026;
function random(max){
 seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 return Math.floor(seed/4294967296*max);
}
const pick=items=>items[random(items.length)];
const take=items=>items.splice(random(items.length),1)[0];
const suits=[...'mps'];
const numbers=suit=>tileTypes.filter(tile=>tile[0]===suit);
const deck=tileTypes.flatMap(tile=>[tile,tile,tile,tile]);
const legal=tiles=>[...tileCounts(tiles).values()].every(count=>count<=4);
const sortHand=hand=>hand.sort((a,b)=>tileTypes.indexOf(a.replace('0','5'))-tileTypes.indexOf(b.replace('0','5')));

function complete(pool,suitPool,tripletBias=3){
 const pair=pick(pool);
 const hand=[pair,pair],melds=[];
 for(let trial=0;melds.length<4&&trial<60;trial++){
  const triplet=pick(pool);
  const suit=pick(suitPool),start=1+random(7);
  const meld=random(10)<tripletBias?[triplet,triplet,triplet]:[suit+start,suit+(start+1),suit+(start+2)];
  if(legal([...hand,...meld])){melds.push(meld);hand.push(...meld);}
 }
 return melds.length===4?{hand,melds}:null;
}

function sevenPairs(){
 const choices=tileTypes.slice();
 return Array.from({length:7},()=>{const tile=take(choices);return [tile,tile];}).flat();
}

function unseen(tiles){
 const pool=deck.slice();
 for(const tile of tiles)pool.splice(pool.indexOf(tile.replace('0','5')),1);
 return pool;
}

function fixture(mode,variant){
 if(mode==='flush'){
  const suit=pick(suits);
  const shape=complete(numbers(suit),[suit],variant%6);
  if(!shape)return null;
  take(shape.hand);
  return {hand:sortHand(shape.hand)};
 }
 const open=mode==='score'&&random(4)===0;
 const suit=pick(suits),style=mode==='score'?random(open?3:9):variant%9;
 const pool=style===0?numbers(suit):style===1?[...numbers(suit),...numbers('z')]:tileTypes;
 const shape=complete(pool,style<=1?[suit]:suits,style===2?8:3);
 if(!shape)return null;
 if(mode==='score'){
  const tsumo=variant>=2,seat=variant%2?1+random(3):0;
  const melds=[];
  if(open){
   const meld=take(shape.melds);
   for(const tile of meld)shape.hand.splice(shape.hand.indexOf(tile),1);
   melds.push(meld[0][0]+meld.map(tile=>tile[1]).join('')+'-');
  }else if(random(7)===0)shape.hand=sevenPairs();
  const all=[...shape.hand,...melds.flatMap(meld=>[...meld.matchAll(/\d/g)].map(([n])=>meld[0]+n))];
  const pool=unseen(all);
  const win=take(shape.hand);
  const riichi=!melds.length&&random(3)!==0;
  return {hand:sortHand(shape.hand),melds,win,tsumo,seat,round:random(2),riichi,
   dora:[take(pool)],ura:riichi?[take(pool)]:[]};
 }
 const hand=style===3?sevenPairs():shape.hand;
 const poolBeforeDiscards=unseen(hand);
 const toReplace=mode==='efficiency'?1+random(3):3+random(3);
 for(let i=0;i<toReplace;i++)take(hand);
 const poolAfterDiscards=unseen(hand);
 const replacementPool=mode==='efficiency'?poolAfterDiscards:poolBeforeDiscards;
 while(hand.length<(mode==='efficiency'?13:14))hand.push(take(replacementPool));
 if(!legal(hand)||M.Util.xiangting(new M.Shoupai(hand))!==(mode==='efficiency'?1:2))return null;
 const poolVisible=unseen(hand);
 const count=style>=4?random(9):0;
 const visible=Array.from({length:count},()=>take(poolVisible));
 return {hand:sortHand(hand),visible:sortHand(visible)};
}

function difficulty(mode,q,a){
 const counts=[...tileCounts(q.hand).values()];
 const repeats=counts.reduce((sum,n)=>sum+(n-1)**2,0);
 if(mode==='flush')return a.tiles.length*4+repeats/10;
 if(mode==='efficiency')return a.tiles.length*2+q.visible.length/2+repeats/20;
 if(mode==='score'){
  const [han,fu]=a.numbers;
  return a.yaku.length*4+(q.melds.length?3:0)+(q.tsumo?2:0)+fu/50+han/20;
 }
 const near=a.options.filter(option=>option.total>=(a.best[0].total-4)).length;
 return near*3+a.best[0].entries.length+q.visible.length/3+a.options.length/20;
}

function addRedFives(q,mode){
 for(const suit of suits){
  const five=suit+'5',red=suit+'0';
  const spots=[];
  for(const list of [q.hand,q.visible,q.dora,q.ura])list?.forEach((tile,i)=>{
   if(tile===five)spots.push(()=>{list[i]=red;});
  });
  if(q.win===five)spots.push(()=>{q.win=red;});
  q.melds?.forEach((meld,i)=>{
   if(meld[0]!==suit)return;
   for(const digit of meld.slice(1))if(digit==='5')spots.push(()=>{q.melds[i]=meld.replace('5','0');});
  });
  if(spots.length===4||(spots.length&&mode==='score'&&random(5)===0))pick(spots)();
 }
}

const bank={};
for(const mode of modes){
 const questions=[],seen=new Set(),variants=mode==='score'?4:1;
 for(let group=0;group<variants;group++){
  const quota=(group+1)*200/variants;
  for(let trial=0;questions.length<quota&&trial<20000;trial++){
   const q=fixture(mode,mode==='score'?group:trial);
   if(!q)continue;
   const key=mode==='flush'?q.hand.map(tile=>tile[1]).join(''):mode==='score'?JSON.stringify([q.hand,q.melds,q.win]):q.hand.join('');
   if(seen.has(key))continue;
   addRedFives(q,mode);
   const answer=analyze(mode,q);
   if(!answer||mode==='flush'&&!answer.tiles.length||mode==='efficiency'&&!answer.total||
      mode==='discard'&&(answer.options.length<2||!answer.best[0]?.total||answer.options.length===answer.best.length))continue;
   questions.push({q,rank:difficulty(mode,q,answer)});
   seen.add(key);
  }
  if(questions.length!==quota)throw Error('Could not fill '+mode+' group '+group);
 }
 bank[mode]=questions.sort((a,b)=>a.rank-b.rank).map(({q})=>q);
}

const lines=Object.entries(bank).map(([mode,questions])=>'  '+JSON.stringify(mode)+': [\n'+
 questions.map(q=>'    '+JSON.stringify(q)).join(',\n')+'\n  ]');
fs.writeFileSync(path.join(__dirname,'drill-bank.json'),'{\n'+lines.join(',\n')+'\n}\n');
