const { Board } = require('./engine');

const winds = '东南西北';
function frameTable(board, rinshan) {
 const players = board.player_id.map((id, seat) => {
  const hand = board.shoupai[seat].toString().split(',')[0];
  return {id, name:board.player[id], score:board.defen[id], hand,
   count:(hand.match(/\d/g)||[]).length,
   river:[...board.he[seat]._pai], melds:[...board.shoupai[seat]._fulou]};
 });
 return {
  round:winds[Math.min(1,board.zhuangfeng)]+(board.zhuangfeng>1?4:board.jushu+1)+'局',
  honba:board.changbang, sticks:board.lizhibang, left:board.shan.paishu,
  dora:[...board.shan.baopai], rinshan, turn:board.lunban, players
 };
}

function buildReplay(record, walls) {
 const board = new Board(record);
 return record.log.map((events, roundIndex) => {
  const start = events[0].qipai;
  let rinshan = 4;
  const frames = events.map(entry => {
   const [type, move] = Object.entries(entry)[0];
   if (type === 'gangzimo') { rinshan--; board.zimo(move); }
   else board[type](move);
   if (type === 'hule' || type === 'pingju') {
    if (move.name === '诈立') {
     board.player_id.forEach((id, seat) => { board.defen[id] = start.defen[seat]; });
     board.lizhibang = start.lizhibang;
    } else {
     move.fenpei.forEach((delta, seat) => { board.defen[board.player_id[seat]] += delta; });
     if (type === 'hule') board.lizhibang = 0;
    }
   }
   return {type, seat:move.l, table:frameTable(board, rinshan),
    ...(type === 'hule' || type === 'pingju' ? {result:move} : {})};
  });
  return {wall:walls[roundIndex], frames};
 });
}

module.exports = { buildReplay };
