const M = require('./engine');
const { leagueRule } = require('./league');

const modes=['flush','efficiency','score','discard'];
const levelSize=5;
const levelCount=40;
const firstLevel=[1,2,3,3,5];
const tenthLevel=[3,3,4,5,6];
const lastLevel=[7,8,8,9,10];
const drillOrder=Array.from({length:levelCount*levelSize},(_,index)=>{
 const level=Math.floor(index/levelSize),slot=index%levelSize;
 const [start,end,fraction]=level<=9
  ?[firstLevel[slot],tenthLevel[slot],level/9]
  :[tenthLevel[slot],lastLevel[slot],(level-9)/(levelCount-10)];
 return {index,weight:start+(end-start)*fraction};
}).sort((a,b)=>a.weight-b.weight).reduce((order,{index,weight},bankIndex)=>{
 order[index]={bankIndex,difficulty:Math.floor(weight)};
 return order;
},[]);
const indexByBank=new Map(drillOrder.map(({bankIndex},index)=>[bankIndex,index]));
const tileTypes=Array.from('mpsz',suit=>Array.from({length:suit==='z'?7:9},(_,i)=>suit+(i+1))).flat();
const normal=tile=>tile.replace('0','5');

function tileCounts(tiles){
 const counts=new Map();
 for(const tile of tiles){
  const type=normal(tile);
  counts.set(type,(counts.get(type)??0)+1);
 }
 return counts;
}

function acceptance(hand,seen){
 return M.Util.tingpai(new M.Shoupai(hand)).map(tile=>[tile,4-(seen.get(tile)??0)]).filter(([,count])=>count>0);
}

const sum=entries=>entries.reduce((total,[,count])=>total+count,0);

function analyze(mode,question){
 const {hand,visible=[],melds=[]}=question;
 if(mode==='score'){
  const {win,tsumo,round,seat,riichi,dora,ura}=question;
  const base=new M.Shoupai(hand).toString();
  const shoupai=M.Shoupai.fromString([base,...melds].join(','));
  if(tsumo)shoupai.zimo(win);
  const result=M.Util.hule(shoupai,tsumo?null:win+'+',M.Util.hule_param({
   rule:leagueRule,menfeng:seat,zhuangfeng:round,lizhi:riichi?1:0,baopai:dora,fubaopai:ura
  }));
  if(!result?.fanshu||!result.defen||result.damanguan)return null;
  const pays=tsumo?(seat?[-result.fenpei[seat===1?2:1],-result.fenpei[0]]:[-result.fenpei[1]]):[result.defen];
  return {numbers:[result.fanshu,result.fu,...pays],yaku:result.hupai};
 }
 const seen=tileCounts([...hand,...visible]);
 if(mode!=='discard'){
  const entries=acceptance(hand,seen);
  return {tiles:entries.map(([tile])=>tile),entries,total:sum(entries)};
 }
 const options=[...new Set(hand.map(normal))].flatMap(tile=>{
  const rest=hand.slice();
  rest.splice(rest.findIndex(p=>normal(p)===tile),1);
  if(M.Util.xiangting(new M.Shoupai(rest))!==2)return [];
  const entries=acceptance(rest,seen);
  return [{tile,entries,total:sum(entries)}];
 }).sort((a,b)=>b.total-a.total);
 const best=options.filter(option=>option.total===options[0]?.total);
 return {tiles:best.map(option=>option.tile),best,options};
}

function grade(mode,solution,answer){
 const number=value=>{
  const text=typeof value==='string'?value.trim().normalize('NFKC'):'';
  if(!/^\d{1,6}$/.test(text))throw Error('数字格请只填数字。');
  return Number(text);
 };
 if(mode==='score'){
  if(!Array.isArray(answer?.numbers)||answer.numbers.length!==solution.numbers.length)throw Error('请填写每一个数字格。');
  return answer.numbers.map(number).every((value,i)=>value===solution.numbers[i]);
 }
 if(mode==='efficiency'){
  const kinds=number(answer?.kinds);
  const total=number(answer?.total);
  return kinds===solution.tiles.length&&total===solution.total;
 }
 const compact=typeof answer?.tiles==='string'?answer.tiles.normalize('NFKC').toLowerCase().replace(/\s/g,''):'';
 const parsed=mode==='flush'?[...compact]:compact.match(/[1-9][mpsz]/g)??[];
 const valid=mode==='flush'?/^[1-9]{1,9}$/.test(compact):parsed.join('')===compact&&parsed.every(tile=>tileTypes.includes(tile[1]+tile[0]));
 if(!valid||!parsed.length||new Set(parsed).size!==parsed.length||(mode==='discard'&&parsed.length!==1))
  throw Error(mode==='flush'?'请填不重复的数字 1–9。':'请用 1m、2p、3s、1z 这样的牌编码，每种牌填一次。');
 if(mode==='discard')return solution.tiles.includes(parsed[0][1]+parsed[0][0]);
 const tiles=solution.tiles.map(tile=>tile[1]);
 return parsed.length===tiles.length&&parsed.every(tile=>tiles.includes(tile));
}

function drillRequest(accounts,accountId,{op,mode,index,answer,favorite}){
 const bank=require('./drill-bank.json');
 const progress=accounts.drillProgress(accountId);
 if(op==='drillProgress')return {progress,levelSize,total:bank.flush.length};
 if(op==='drillFavorites'){
  const favorites=accounts.drillFavorites(accountId).flatMap(({mode,bank_index})=>{
   const index=indexByBank.get(bank_index);
   if(!modes.includes(mode)||index==null||index>(progress[mode]??0))return [];
   return [{mode,index,difficulty:drillOrder[index].difficulty}];
  });
  return {favorites};
 }
 if(!modes.includes(mode)||!Number.isInteger(index)||index<0||index>=bank[mode].length||index>(progress[mode]??0))
  throw Error('这道题尚未解锁。');
 const {bankIndex,difficulty}=drillOrder[index];
 const question=bank[mode][bankIndex];
 if(op==='drillQuestion')return {question,difficulty,favorite:accounts.isDrillFavorite(accountId,mode,bankIndex)};
 if(op==='drillFavorite'){
  if(typeof favorite!=='boolean')throw Error('收藏状态无效。');
  accounts.setDrillFavorite(accountId,mode,bankIndex,favorite);
  return {favorite};
 }
 const solution=analyze(mode,question);
 const correct=grade(mode,solution,answer);
 if(correct&&index>=(progress[mode]??0))accounts.solveDrill(accountId,mode,index+1);
 return {correct,solution,solved:Math.max(progress[mode]??0,correct?index+1:0)};
}

module.exports={drillRequest,analyze,grade,tileCounts,tileTypes,modes};
