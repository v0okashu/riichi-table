const assert=require('node:assert/strict');
const M=require('./engine');
const {analyze,grade,tileCounts,tileTypes,modes,drillRequest}=require('./drills');
const bank=require('./drill-bank.json');

const code=tile=>tile[1]+tile[0];
const normal=tile=>tile.replace('0','5');
const shanten=hand=>M.Util.xiangting(new M.Shoupai(hand));
const draws=(hand,seen,goal)=>tileTypes.flatMap(tile=>{
 const count=4-(seen.get(tile)??0);
 return count>0&&shanten([...hand,tile])===goal?[[tile,count]]:[];
});

const paymentCases=new Map();
for(const mode of modes){
 const unlocked={drillProgress:()=>({[mode]:200}),isDrillFavorite:()=>false};
 const ordered=bank[mode].map((_,index)=>drillRequest(unlocked,1,{op:'drillQuestion',mode,index}));
 const difficulty=ordered.map(entry=>entry.difficulty);
 assert.deepEqual(difficulty.slice(0,5),[1,2,3,3,5]);
 assert.deepEqual(difficulty.slice(45,50),[3,3,4,5,6]);
 assert.equal(difficulty.at(-1),10);
 assert.equal(new Set(ordered.map(entry=>entry.question)).size,200);
 const ranks=ordered.map(entry=>bank[mode].indexOf(entry.question));
 for(let i=0;i<ranks.length;i++){
  if(i%5)assert(ranks[i]>=ranks[i-1]&&difficulty[i]>=difficulty[i-1]);
  if(i>=5)assert(ranks[i]>=ranks[i-5]&&difficulty[i]>=difficulty[i-5]);
 }
 for(let i=0;i<difficulty.length;i+=5)assert(difficulty[i]<difficulty[i+4]);
 const keys=new Set();
 assert.equal(bank[mode].length,200);
 for(const question of bank[mode]){
  const {hand,melds=[],visible=[],win,tsumo,seat,dora=[],ura=[]}=question;
  const key=mode==='flush'?hand.map(tile=>normal(tile)[1]).join(''):JSON.stringify([hand.map(normal),melds,win]);
  assert(!keys.has(key));
  keys.add(key);
  const meldTiles=melds.flatMap(meld=>[...meld.matchAll(/\d/g)].map(([n])=>meld[0]+n));
  const held=[...hand,...meldTiles,...visible,...(win?[win]:[]),...dora,...ura];
  const seen=tileCounts(held);
  for(const [tile,count] of seen){
   assert(count<=4);
   if(tile[0]!=='z'&&tile[1]==='5'){
    assert(held.filter(p=>p===tile).length<=3);
    assert(held.filter(p=>p===tile[0]+'0').length<=1);
   }
  }
  const solution=analyze(mode,question);
  assert(solution);
  if(mode==='score'){
   assert.equal(hand.length+meldTiles.length,13);
   for(const meld of melds)assert(M.Shoupai.valid_mianzi(meld));
   const [han,fu]=solution.numbers;
   const raw=fu*2**(2+han);
   const base=han>=11?6000:han>=8?4000:han>=6?3000:raw===1920?2000:Math.min(raw,2000);
   const round100=points=>Math.ceil(points/100)*100;
   const payments=tsumo?(seat?[round100(base),round100(base*2)]:[round100(base*2)]):[round100(base*(seat?4:6))];
   assert.deepEqual(solution.numbers.slice(2),payments);
   assert(grade(mode,solution,{numbers:solution.numbers.map(String)}));
   const type=Number(tsumo)+':'+Number(seat===0);
   paymentCases.set(type,(paymentCases.get(type)??0)+1);
   continue;
  }
  const initial={flush:0,efficiency:1,discard:2}[mode];
  assert.equal(shanten(hand),initial);
  assert.equal(hand.length,mode==='discard'?14:13);
  if(mode==='discard'){
   const totals=[...new Set(hand.map(normal))].map(tile=>{
    const rest=hand.slice();
    rest.splice(rest.findIndex(p=>normal(p)===tile),1);
    return [tile,draws(rest,seen,1).reduce((sum,[,count])=>sum+count,0)];
   });
   const max=Math.max(...totals.map(([,count])=>count));
   assert.deepEqual(solution.tiles,totals.filter(([,count])=>count===max).map(([tile])=>tile));
   for(const tile of solution.tiles)assert(grade(mode,solution,{tiles:code(tile)}));
  }else{
   assert.deepEqual(solution.entries,draws(hand,seen,initial-1));
   if(mode==='flush')assert(grade(mode,solution,{tiles:solution.tiles.map(tile=>tile[1]).reverse().join('')}));
   else{
    const answer={kinds:String(solution.tiles.length),total:String(solution.total)};
    assert(grade(mode,solution,answer));
    assert.equal(grade(mode,solution,{...answer,kinds:String(solution.tiles.length+1)}),false);
    assert.equal(grade(mode,solution,{...answer,total:String(solution.total+1)}),false);
    assert.throws(()=>grade(mode,solution,{...answer,kinds:answer.kinds+'种'}));
   }
  }
 }
}
assert.deepEqual([...paymentCases.values()],[50,50,50,50]);
assert(bank.score.filter(question=>question.melds.length).length>20);
assert.throws(()=>grade('flush',{tiles:['m1']},{tiles:'一'}));
assert.throws(()=>grade('discard',{tiles:['z7']},{tiles:'8z'}));
assert.throws(()=>grade('score',{numbers:[1,40,1300]},{numbers:['1','40符','1300']}));
console.log('Verified 800 questions, level difficulty, tile availability, effective draws, all optimal discards and the four scoring formats.');
