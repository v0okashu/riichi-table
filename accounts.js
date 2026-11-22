const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {gzipSync,gunzipSync} = require('node:zlib');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const ranks = ['小小狗', '小狗', '狗狗的', '狗完了', '狗王', '最狗位'];
const windowSize = 10;
const sessionLifetime = 30 * 24 * 60 * 60;
const scrypt = promisify(crypto.scrypt);
const digest = token => crypto.createHash('sha256').update(token).digest('hex');

function openAccounts(file) {
 fs.mkdirSync(path.dirname(file), {recursive:true});
 const db = new DatabaseSync(file);
 db.exec(`
  PRAGMA foreign_keys=ON;
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=4000;
  CREATE TABLE IF NOT EXISTS accounts (
   id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL,
   salt BLOB NOT NULL, password_hash BLOB NOT NULL,
   rank INTEGER NOT NULL DEFAULT 0, stage INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
   hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
   expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ranked_matches (
   seq INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
   match_id TEXT NOT NULL, stage INTEGER NOT NULL, points INTEGER NOT NULL,
   UNIQUE(account_id, match_id)
  );
  CREATE TABLE IF NOT EXISTS completed_matches (
   id TEXT PRIMARY KEY, played_at TEXT NOT NULL, account_ids TEXT NOT NULL,
   names TEXT NOT NULL, final TEXT NOT NULL, round_count INTEGER NOT NULL,
   replay BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ranked_recent ON ranked_matches(account_id, stage, seq DESC);
 `);

 const byId = db.prepare('SELECT id, nickname, rank, stage FROM accounts WHERE id=?');
 const lookup = db.prepare('SELECT id, salt, password_hash FROM accounts WHERE username=?');
 const insertAccount = db.prepare(`
  INSERT INTO accounts(username,nickname,salt,password_hash) VALUES(?,?,?,?)
  ON CONFLICT(username) DO NOTHING RETURNING id
 `);
 const removeExpired = db.prepare('DELETE FROM sessions WHERE expires<=?');
 const insertSession = db.prepare('INSERT INTO sessions VALUES(?,?,?)');
 const findSession = db.prepare('SELECT account_id FROM sessions WHERE hash=? AND expires>?');
 const removeSession = db.prepare('DELETE FROM sessions WHERE hash=?');
 const history = db.prepare(`
  SELECT count(*) AS count, coalesce(sum(points),0) AS points FROM (
   SELECT points FROM ranked_matches WHERE account_id=? AND stage=? ORDER BY seq DESC LIMIT ?
  )
 `);
 const stageTotal = db.prepare('SELECT coalesce(sum(points),0) AS points FROM ranked_matches WHERE account_id=? AND stage=?');
 const insertResult = db.prepare(`
  INSERT INTO ranked_matches(account_id,match_id,stage,points) VALUES(?,?,?,?)
  ON CONFLICT(account_id,match_id) DO NOTHING
 `);
 const insertArchive = db.prepare(`INSERT INTO completed_matches VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
 const archiveList = db.prepare(`SELECT m.id, m.played_at, m.account_ids, m.names, m.final, m.round_count
  FROM ranked_matches r JOIN completed_matches m ON m.id=r.match_id
  WHERE r.account_id=? ORDER BY m.played_at DESC`);
 const archiveById = db.prepare(`SELECT m.* FROM ranked_matches r JOIN completed_matches m ON m.id=r.match_id WHERE r.account_id=? AND m.id=?`);
 const setRank = db.prepare('UPDATE accounts SET rank=?, stage=stage+1 WHERE id=?');

 function profile(id) {
  const account = byId.get(id);
  const recent = history.get(id,account.stage,windowSize);
  return {id,nickname:account.nickname,rank:ranks[account.rank],recentCount:recent.count,
   recentPoints:recent.points/10,
   ...(account.rank===ranks.length-1?{topPoints:stageTotal.get(id,account.stage).points/10}:{})};
 }

 function session(id) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Math.floor(Date.now()/1000);
  removeExpired.run(now);
  insertSession.run(digest(token),id,now+sessionLifetime);
  return {token,profile:profile(id)};
 }

 async function authenticate(op, body) {
  const username = typeof body.username==='string'?body.username.trim().toLowerCase():'';
  const password = typeof body.password==='string'?body.password:'';
  const validUsername = /^[a-z0-9_]{3,24}$/.test(username);
  const validPassword = password.length>=8 && password.length<=128;
  if(op==='register'){
   const nickname = typeof body.nickname==='string'?body.nickname.trim():'';
   if(!validUsername)throw Error('账号须为 3～24 位字母、数字或下划线');
   if(!validPassword)throw Error('密码长度须为 8～128 个字符');
   if(!nickname || Array.from(nickname).length>12 || /[\x00-\x1f\x7f]/.test(nickname))throw Error('昵称须为 1～12 个字符');
   const salt = crypto.randomBytes(16);
   const passwordHash = await scrypt(password,salt,64);
   const account = insertAccount.get(username,nickname,salt,passwordHash);
   if(!account)throw Error('这个账号已被注册');
   return session(account.id);
  }
  if(!validUsername||!validPassword)throw Error('账号或密码错误');
  const account = lookup.get(username);
  const passwordHash = await scrypt(password,account?.salt??Buffer.alloc(16),64);
  if(!account || !crypto.timingSafeEqual(passwordHash,account.password_hash))throw Error('账号或密码错误');
  return session(account.id);
 }

 function accountId(token) {
  return token ? findSession.get(digest(token),Math.floor(Date.now()/1000))?.account_id : undefined;
 }

 function logout(token) {
  if(token)removeSession.run(digest(token));
 }

 function matchSummary(row,id){
  return {id:row.id,at:row.played_at,viewer:JSON.parse(row.account_ids).indexOf(id),
   names:JSON.parse(row.names),final:JSON.parse(row.final),roundCount:row.round_count};
 }

 function matches(id){
  return archiveList.all(id).map(row=>matchSummary(row,id));
 }

 function savedMatch(id,matchId){
  const row=archiveById.get(id,matchId);
  if(!row)return null;
  return {...matchSummary(row,id),...JSON.parse(gunzipSync(row.replay).toString('utf8'))};
 }

 function applyMatch(matchId, participants, archive) {
  const packed=archive && gzipSync(JSON.stringify({record:archive.record,walls:archive.walls}));
  const changes = {};
  db.exec('BEGIN IMMEDIATE');
  try {
   if(archive)insertArchive.run(matchId,archive.at,JSON.stringify(archive.accountIds),
    JSON.stringify(archive.record.player),JSON.stringify(archive.final),archive.record.log.length,packed);
   for(const {id,points} of participants){
    const {rank,stage} = byId.get(id);
    const inserted = insertResult.run(id,matchId,stage,Math.round(points*10));
    const recent = history.get(id,stage,windowSize);
    let next = rank;
    if(inserted.changes && recent.count===windowSize){
     if(recent.points>=2000 && rank<ranks.length-1)next++;
     if(recent.points < -2000 && rank>0)next--;
    }
    if(next!==rank)setRank.run(next,id);
    changes[id]={profile:profile(id),previousRank:ranks[rank],windowPoints:recent.points/10};
   }
   db.exec('COMMIT');
   return changes;
  }catch(error){
   db.exec('ROLLBACK');
   throw error;
  }
 }

 return {authenticate,accountId,logout,profile,applyMatch,matches,savedMatch};
}

module.exports = {openAccounts,sessionLifetime};
