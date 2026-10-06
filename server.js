require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");
const { Telegraf, Markup } = require("telegraf");

const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "");
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || "";
const CHANNEL_URL = process.env.CHANNEL_URL || "";
const WEBAPP_URL = process.env.WEBAPP_URL || "";
const START_COINS = Number(process.env.START_COINS || 0);

if (!BOT_TOKEN) console.warn("BOT_TOKEN is not set. Bot will not start until it is added in Render.");

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(path.join(__dirname, "roulette.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  coins INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_free_spin INTEGER NOT NULL DEFAULT 0,
  referral_parent INTEGER,
  referral_rewarded INTEGER NOT NULL DEFAULT 0,
  channel_rewarded INTEGER NOT NULL DEFAULT 0,
  first_spin_done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS spins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  reward_key TEXT NOT NULL,
  reward_label TEXT NOT NULL,
  cost INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  reward_key TEXT NOT NULL,
  reward_label TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL,
  referred_id INTEGER UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  rewarded_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_spins_user_time ON spins(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_codes_user ON codes(user_id);
`);

const defaults = {
  free_spin_hours: "24",
  paid_spin_cost: "100",
  paid_spin_limit: "5",
  exchange_uc_cost: "3500",
  exchange_discount_cost: "900",
  uc_inventory: "1",
  reward_50_weight: "15",
  reward_100a_weight: "10",
  reward_150a_weight: "7",
  reward_100b_weight: "6",
  reward_150b_weight: "5",
  reward_discount_weight: "3",
  reward_uc_weight: "0.2",
  reward_nothing_weight: "50"
};
const insSetting = db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)");
for (const [k,v] of Object.entries(defaults)) insSetting.run(k,v);

function setting(key) {
  const r = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return r ? r.value : "";
}
function numSetting(key, fallback) {
  const n = Number(setting(key));
  return Number.isFinite(n) ? n : fallback;
}
function now() { return Date.now(); }

function upsertUser(tg) {
  const id = Number(tg.id);
  const existing = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  if (!existing) {
    db.prepare(`INSERT INTO users(id,username,first_name,coins,created_at)
      VALUES(?,?,?,?,?)`).run(id, tg.username || "", tg.first_name || "", START_COINS, now());
  } else {
    db.prepare("UPDATE users SET username=?, first_name=? WHERE id=?")
      .run(tg.username || existing.username || "", tg.first_name || existing.first_name || "", id);
  }
  return db.prepare("SELECT * FROM users WHERE id=?").get(id);
}

function parseInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const dataCheck = [...params.entries()].sort(([a],[b]) => a.localeCompare(b))
      .map(([k,v]) => `${k}=${v}`).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calculated = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(hash))) return null;
    const authDate = Number(params.get("auth_date") || 0);
    if (!authDate || Math.floor(Date.now()/1000) - authDate > 86400) return null;
    const user = JSON.parse(params.get("user") || "{}");
    if (!user.id) return null;
    return user;
  } catch (_) { return null; }
}

function auth(req, res, next) {
  const user = parseInitData(req.headers["x-telegram-init-data"] || "");
  if (!user) return res.status(401).json({error:"Открой рулетку через Telegram."});
  req.tgUser = user;
  req.user = upsertUser(user);
  next();
}

function adminOnly(req,res,next) {
  if (String(req.user.id) !== ADMIN_ID) return res.status(403).json({error:"Нет доступа"});
  next();
}

function activePaidSpins(userId) {
  const since = now() - 86400000;
  return db.prepare("SELECT COUNT(*) c FROM spins WHERE user_id=? AND kind='paid' AND created_at>=?")
    .get(userId, since).c;
}

function isMemberStatus(status) {
  return ["creator","administrator","member"].includes(status);
}

async function checkSubscription(userId) {
  if (!bot || !CHANNEL_USERNAME) return false;
  try {
    const m = await bot.telegram.getChatMember(CHANNEL_USERNAME, userId);
    return isMemberStatus(m.status);
  } catch (e) {
    console.error("getChatMember:", e.message);
    return false;
  }
}

function randomCode(prefix) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  do {
    for (let i=0;i<10;i++) s += chars[crypto.randomInt(chars.length)];
  } while (db.prepare("SELECT 1 FROM codes WHERE code=?").get(`${prefix}-${s}`));
  return `${prefix}-${s}`;
}

function createCode(userId, rewardKey, rewardLabel, source) {
  const prefix = rewardKey === "uc60" ? "UC60" : "DISC25";
  const code = randomCode(prefix);
  const created = now();
  const expires = created + 10*86400000;
  db.prepare(`INSERT INTO codes(code,user_id,reward_key,reward_label,source,status,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(code,userId,rewardKey,rewardLabel,source,"pending",created,expires);
  return db.prepare("SELECT * FROM codes WHERE code=?").get(code);
}

function expireCodes() {
  db.prepare("UPDATE codes SET status='expired' WHERE status='pending' AND expires_at<=?").run(now());
}

function rewardList() {
  return [
    {key:"coins50", label:"50 монет", type:"coins", value:50, weight:numSetting("reward_50_weight",15)},
    {key:"coins100a", label:"100 монет", type:"coins", value:100, weight:numSetting("reward_100a_weight",10)},
    {key:"coins150a", label:"150 монет", type:"coins", value:150, weight:numSetting("reward_150a_weight",7)},
    {key:"coins100b", label:"100 монет", type:"coins", value:100, weight:numSetting("reward_100b_weight",6)},
    {key:"coins150b", label:"150 монет", type:"coins", value:150, weight:numSetting("reward_150b_weight",5)},
    {key:"discount25", label:"25% скидка на экипировку", type:"code", value:0, weight:numSetting("reward_discount_weight",3)},
    {key:"uc60", label:"60 UC", type:"code", value:0, weight:numSetting("reward_uc_weight",0.2)},
    {key:"nothing", label:"Ничего", type:"nothing", value:0, weight:numSetting("reward_nothing_weight",50)}
  ];
}
function pickReward() {
  let list = rewardList();
  const uc = Number(setting("uc_inventory") || 0);
  if (uc <= 0) list = list.filter(r => r.key !== "uc60");
  const total = list.reduce((a,r)=>a+Math.max(0,r.weight),0);
  let x = Math.random()*total;
  for (const r of list) {
    x -= Math.max(0,r.weight);
    if (x < 0) return r;
  }
  return list[list.length-1];
}

async function notifyAdmin(code, user) {
  if (!bot || !ADMIN_ID || !code) return;
  const text =
    `🔔 <b>Новая заявка на выдачу</b>\n\n` +
    `👤 ${escapeHtml(user.first_name || "")} ${user.username ? "@"+escapeHtml(user.username) : ""}\n` +
    `🆔 <code>${user.id}</code>\n` +
    `🎁 ${escapeHtml(code.reward_label)}\n` +
    `🔑 <code>${code.code}</code>\n` +
    `⏳ До: ${new Date(code.expires_at).toLocaleString("ru-RU")}\n` +
    `📌 Источник: ${escapeHtml(code.source)}`;
  try {
    await bot.telegram.sendMessage(ADMIN_ID, text, {
      parse_mode:"HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Выдано", `issue:${code.id}`),
         Markup.button.callback("❌ Аннулировать", `cancel:${code.id}`)]
      ])
    });
  } catch(e) { console.error("admin notify:", e.message); }
}
function escapeHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

async function maybeRewardReferral(userId) {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  if (!u || !u.referral_parent || u.referral_rewarded) return;
  if (!u.channel_rewarded || !u.first_spin_done) return;
  const ref = db.prepare("SELECT * FROM referrals WHERE referred_id=?").get(userId);
  if (!ref || ref.rewarded_at) return;
  db.transaction(() => {
    db.prepare("UPDATE users SET coins=coins+100 WHERE id=?").run(ref.referrer_id);
    db.prepare("UPDATE users SET referral_rewarded=1 WHERE id=?").run(userId);
    db.prepare("UPDATE referrals SET rewarded_at=? WHERE referred_id=?").run(now(),userId);
  })();
  if (bot) {
    try {
      await bot.telegram.sendMessage(ref.referrer_id, "🎉 Друг выполнил условия реферала! Тебе начислено <b>100 монет</b>.", {parse_mode:"HTML"});
    } catch(e) {}
  }
}

app.get("/health", (_,res)=>res.json({ok:true}));
app.get("/api/config", (_,res)=>res.json({
  rewards: rewardList().map(r=>({key:r.key,label:r.label,type:r.type})),
  exchange:{uc:numSetting("exchange_uc_cost",3500),discount:numSetting("exchange_discount_cost",900)},
  paid:{cost:numSetting("paid_spin_cost",100),limit:numSetting("paid_spin_limit",5)}
}));

app.get("/api/me", auth, (req,res)=>{
  expireCodes();
  const u = req.user;
  const codes = db.prepare("SELECT code,reward_label,status,created_at,expires_at,source FROM codes WHERE user_id=? ORDER BY id DESC").all(u.id);
  const spins = db.prepare("SELECT kind,reward_label,cost,created_at FROM spins WHERE user_id=? ORDER BY id DESC LIMIT 30").all(u.id);
  const paidUsed = activePaidSpins(u.id);
  res.json({
    user:{id:u.id,username:u.username,first_name:u.first_name,coins:u.coins},
    freeReady: now()-u.last_free_spin >= numSetting("free_spin_hours",24)*3600000,
    paidUsed, paidLimit:numSetting("paid_spin_limit",5),
    paidCost:numSetting("paid_spin_cost",100),
    codes, spins,
    referralLink: BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=ref_${u.id}` : "",
    admin:String(u.id)===ADMIN_ID
  });
});

app.post("/api/spin", auth, async (req,res)=>{
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  const requestedKind = req.body?.kind === "paid" ? "paid" : "free";
  if (requestedKind === "free") {
    const hours = numSetting("free_spin_hours",24);
    if (now()-u.last_free_spin < hours*3600000)
      return res.status(400).json({error:"Бесплатная прокрутка будет доступна через 24 часа."});
  } else {
    const used = activePaidSpins(u.id);
    const limit = numSetting("paid_spin_limit",5);
    const cost = numSetting("paid_spin_cost",100);
    if (used >= limit) return res.status(400).json({error:"Лимит платных прокруток за 24 часа исчерпан."});
    if (u.coins < cost) return res.status(400).json({error:"Недостаточно монет."});
  }
  const reward = pickReward();
  let code = null;
  const cost = requestedKind === "paid" ? numSetting("paid_spin_cost",100) : 0;

  db.transaction(() => {
    if (requestedKind === "free")
      db.prepare("UPDATE users SET last_free_spin=? WHERE id=?").run(now(),u.id);
    else
      db.prepare("UPDATE users SET coins=coins-? WHERE id=?").run(cost,u.id);

    if (reward.type === "coins")
      db.prepare("UPDATE users SET coins=coins+? WHERE id=?").run(reward.value,u.id);
    if (reward.key === "uc60") {
      const inv = Number(setting("uc_inventory") || 0);
      if (inv > 0) db.prepare("UPDATE settings SET value=? WHERE key='uc_inventory'").run(String(inv-1));
    }
    db.prepare(`INSERT INTO spins(user_id,kind,reward_key,reward_label,cost,created_at)
      VALUES(?,?,?,?,?,?)`).run(u.id,requestedKind,reward.key,reward.label,cost,now());
    if (reward.type === "code") code = createCode(u.id,reward.key,reward.label,"roulette");
    db.prepare("UPDATE users SET first_spin_done=1 WHERE id=?").run(u.id);
  })();

  const fresh = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  if (code) await notifyAdmin(code, fresh);
  await maybeRewardReferral(u.id);

  res.json({reward,code,coins:fresh.coins});
});

app.post("/api/exchange", auth, async (req,res)=>{
  const key = req.body?.key;
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  let cost, rewardKey, label;
  if (key === "uc60") { cost=numSetting("exchange_uc_cost",3500); rewardKey="uc60"; label="60 UC"; }
  else if (key === "discount25") { cost=numSetting("exchange_discount_cost",900); rewardKey="discount25"; label="25% скидка на экипировку"; }
  else return res.status(400).json({error:"Неизвестный обмен"});
  if (rewardKey==="uc60" && Number(setting("uc_inventory")||0)<=0)
    return res.status(400).json({error:"60 UC сейчас закончились."});
  if (u.coins < cost) return res.status(400).json({error:`Нужно ${cost} монет.`});

  let code;
  db.transaction(() => {
    db.prepare("UPDATE users SET coins=coins-? WHERE id=?").run(cost,u.id);
    if (rewardKey==="uc60") {
      const inv=Number(setting("uc_inventory")||0);
      db.prepare("UPDATE settings SET value=? WHERE key='uc_inventory'").run(String(inv-1));
    }
    code=createCode(u.id,rewardKey,label,"exchange");
  })();
  const fresh=db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  await notifyAdmin(code,fresh);
  res.json({code,coins:fresh.coins});
});

app.get("/api/admin/summary", auth, adminOnly, (_,res)=>{
  expireCodes();
  const users=db.prepare("SELECT COUNT(*) c FROM users").get().c;
  const spins=db.prepare("SELECT COUNT(*) c FROM spins").get().c;
  const pending=db.prepare("SELECT COUNT(*) c FROM codes WHERE status='pending'").get().c;
  const referrals=db.prepare("SELECT COUNT(*) c FROM referrals WHERE rewarded_at IS NOT NULL").get().c;
  const codes=db.prepare(`SELECT c.*,u.username,u.first_name FROM codes c LEFT JOIN users u ON u.id=c.user_id ORDER BY c.id DESC LIMIT 100`).all();
  res.json({users,spins,pending,referrals,inventory:Number(setting("uc_inventory")||0),settings:Object.fromEntries(Object.keys(defaults).map(k=>[k,setting(k)])),codes});
});

app.post("/api/admin/settings", auth, adminOnly, (req,res)=>{
  const allowed=Object.keys(defaults);
  const data=req.body || {};
  const stmt=db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for(const k of allowed) if(data[k] !== undefined && String(data[k]).trim()!=="") stmt.run(k,String(data[k]));
  res.json({ok:true});
});

app.post("/api/admin/code", auth, adminOnly, (req,res)=>{
  const id=Number(req.body?.id);
  const status=req.body?.status;
  if(!["issued","cancelled"].includes(status)) return res.status(400).json({error:"Статус"});
  const c=db.prepare("SELECT * FROM codes WHERE id=?").get(id);
  if(!c) return res.status(404).json({error:"Код не найден"});
  if(c.status!=="pending") return res.status(400).json({error:"Код уже закрыт"});
  db.prepare("UPDATE codes SET status=? WHERE id=?").run(status,id);
  res.json({ok:true});
});

if (BOT_TOKEN) {
  var bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx)=>{
    const p=(ctx.startPayload || "").trim();
    const u=upsertUser(ctx.from);
    if(p.startsWith("ref_")){
      const refId=Number(p.slice(4));
      if(refId && refId!==u.id && !u.referral_parent){
        const refUser=db.prepare("SELECT id FROM users WHERE id=?").get(refId);
        if(refUser){
          db.prepare("UPDATE users SET referral_parent=? WHERE id=?").run(refId,u.id);
          db.prepare("INSERT OR IGNORE INTO referrals(referrer_id,referred_id,created_at) VALUES(?,?,?)").run(refId,u.id,now());
        }
      }
    }
    const kb = [
      [Markup.button.url("➡️ Перейти в канал", CHANNEL_URL || "https://t.me/")],
      [Markup.button.callback("✅ Проверить подписку","check_sub")],
      [Markup.button.webApp("🎰 Открыть рулетку", WEBAPP_URL || "https://example.com")]
    ];
    await ctx.reply(
      `🎰 <b>Elite Force — Рулетка</b>\n\n`+
      `Подпишись на канал и получи <b>50 монет</b>.\n`+
      `После этого открывай рулетку.\n\n`+
      `Также у тебя будет персональная реферальная ссылка.`,
      {parse_mode:"HTML", ...Markup.inlineKeyboard(kb)}
    );
  });

  bot.action("check_sub", async ctx=>{
    await ctx.answerCbQuery();
    const u=upsertUser(ctx.from);
    const ok=await checkSubscription(u.id);
    if(!ok) return ctx.reply("❌ Подписка не найдена. Нажми «Перейти в канал», подпишись, затем снова «Проверить подписку».");
    if(!u.channel_rewarded){
      db.prepare("UPDATE users SET coins=coins+50, channel_rewarded=1 WHERE id=?").run(u.id);
      await ctx.reply("✅ Подписка подтверждена! Тебе начислено <b>50 монет</b>.",{parse_mode:"HTML"});
      await maybeRewardReferral(u.id);
    } else {
      await ctx.reply("✅ Подписка уже была засчитана ранее.");
    }
  });

  bot.command("ref", async ctx=>{
    const u=upsertUser(ctx.from);
    const link=BOT_USERNAME?`https://t.me/${BOT_USERNAME}?start=ref_${u.id}`:"";
    await ctx.reply(`👥 Твоя реферальная ссылка:\n${link}\n\nЗа приглашённого друга начислится 100 монет после его подписки на канал и первой прокрутки.`,{disable_web_page_preview:true});
  });

  bot.command("admin", async ctx=>{
    if(String(ctx.from.id)!==ADMIN_ID) return;
    await ctx.reply("👑 Админ-панель находится внутри Mini App. Открой рулетку.");
  });

  bot.catch((e)=>console.error("BOT ERROR",e));
  bot.launch().then(()=>console.log("Bot started")).catch(e=>console.error("Bot launch failed",e));
  process.once("SIGINT",()=>bot.stop("SIGINT"));
  process.once("SIGTERM",()=>bot.stop("SIGTERM"));

  bot.use(async (ctx,next)=>{
    if(ctx.callbackQuery?.data?.startsWith("issue:") || ctx.callbackQuery?.data?.startsWith("cancel:")){
      if(String(ctx.from.id)!==ADMIN_ID) return ctx.answerCbQuery("Нет доступа");
      const [action,idStr]=ctx.callbackQuery.data.split(":");
      const id=Number(idStr);
      const status=action==="issue"?"issued":"cancelled";
      const c=db.prepare("SELECT * FROM codes WHERE id=?").get(id);
      if(!c) return ctx.answerCbQuery("Код не найден");
      if(c.status!=="pending") return ctx.answerCbQuery("Код уже закрыт");
      db.prepare("UPDATE codes SET status=? WHERE id=?").run(status,id);
      await ctx.answerCbQuery(status==="issued"?"Выдано":"Аннулировано");
      try { await ctx.editMessageReplyMarkup({inline_keyboard:[]}); } catch(e) {}
      try { await ctx.reply(status==="issued"?`✅ Код ${c.code} отмечен как «Выдано».`:`❌ Код ${c.code} аннулирован.`); } catch(e) {}
      return;
    }
    return next();
  });
}

setInterval(expireCodes, 60*1000);
app.listen(PORT, ()=>console.log(`HTTP server listening on ${PORT}`));
