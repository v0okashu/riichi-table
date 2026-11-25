const { DatabaseSync } = require('node:sqlite');

function openRoomStore(file) {
 const db=new DatabaseSync(file);
 db.exec(`
  PRAGMA foreign_keys=ON;
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=4000;
  CREATE TABLE IF NOT EXISTS lan_rooms (
   code TEXT PRIMARY KEY, address TEXT NOT NULL, group_code TEXT NOT NULL,
   seats TEXT NOT NULL, match_id TEXT, dealer INTEGER
  );
  CREATE TABLE IF NOT EXISTS lan_events (
   seq INTEGER PRIMARY KEY, code TEXT NOT NULL REFERENCES lan_rooms(code) ON DELETE CASCADE,
   kind TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS lan_events_room ON lan_events(code,seq);
 `);
 const rooms=db.prepare('SELECT * FROM lan_rooms ORDER BY rowid');
 const events=db.prepare('SELECT kind,data FROM lan_events WHERE code=? ORDER BY seq');
 const upsert=db.prepare(`INSERT INTO lan_rooms VALUES(?,?,?,?,?,?)
  ON CONFLICT(code) DO UPDATE SET seats=excluded.seats,match_id=excluded.match_id,dealer=excluded.dealer`);
 const append=db.prepare('INSERT INTO lan_events(code,kind,data) VALUES(?,?,?)');
 const remove=db.prepare('DELETE FROM lan_rooms WHERE code=?');
 const clearEvents=db.prepare('DELETE FROM lan_events WHERE code=?');
 function save(room){
  upsert.run(room.code,room.address,room.groupCode,
   JSON.stringify(room.seats.map(({name,accountId,token})=>({name,accountId,token}))),room.matchId??null,room.dealer??null);
 }
 return {
  load:()=>rooms.all().map(row=>({code:row.code,address:row.address,groupCode:row.group_code,
   seats:JSON.parse(row.seats),matchId:row.match_id,dealer:row.dealer,
   events:events.all(row.code).map(({kind,data})=>[kind,JSON.parse(data)])})),
  save,
  finish(room){
   db.exec('BEGIN IMMEDIATE');
   try{
    save({...room,matchId:null,dealer:null});
    clearEvents.run(room.code);
    db.exec('COMMIT');
   }catch(error){
    db.exec('ROLLBACK');
    throw error;
   }
  },
  append:(code,kind,data)=>append.run(code,kind,JSON.stringify(data)),
  remove:code=>remove.run(code)
 };
}

module.exports={openRoomStore};
