// Vercel Serverless Function - Discord yönetim paneli arka ucu (tek adres: /api/panel)
// Ortam değişkenleri:
//   DISCORD_TOKEN, GUILD_ID, PANEL_PASSWORD            (zorunlu)
//   DISCORD_PUBLIC_KEY                                  (ticket butonları için: Developer Portal → General Information → Public Key)
//   AUTO_ROLE_ID, CRON_SECRET, AUTO_ROLE_WINDOW_MIN     (isteğe bağlı: zamanlanmış otomatik rol)

const crypto = require("crypto");

const API = "https://discord.com/api/v10";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isId = (s) => typeof s === "string" && /^\d{15,22}$/.test(s);
const httpErr = (status, msg) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};
const snowTime = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);

async function discord(path, method = "GET", body, reason = "Web panel") {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
        "content-type": "application/json",
        "X-Audit-Log-Reason": encodeURIComponent(String(reason).slice(0, 400)),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return { ok: true };
    const data = await r.json().catch(() => ({}));
    if (r.status === 429 && attempt < 2) {
      await sleep(Math.min((data.retry_after || 1) * 1000, 4000) + 50);
      continue;
    }
    if (!r.ok) {
      const err = new Error(data.message || `Discord hatası ${r.status}`);
      err.status = r.status;
      err.code = data.code;
      throw err;
    }
    return data;
  }
}

// Ham gövde okunur (Discord imza doğrulaması için gerekli). bodyParser kapalı: dosya sonundaki config'e bak.
function readRaw(req) {
  if (typeof req.body === "string") return Promise.resolve(req.body);
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString("utf8"));
  if (req.body && typeof req.body === "object") return Promise.resolve(JSON.stringify(req.body));
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---- embed temizleme (sadece izin verilen alanlar geçer) ----
const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const url = (v) => {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v.trim());
    return /^https?:$/.test(u.protocol) ? u.href : undefined;
  } catch { return undefined; }
};
function cleanEmbed(e, keepTs = false) {
  if (!e || typeof e !== "object") return null;
  const out = {};
  const title = str(e.title, 256); if (title) out.title = title;
  const desc = str(e.description, 4096); if (desc) out.description = desc;
  const link = url(e.url); if (link) out.url = link;
  if (Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff) out.color = e.color;
  if (e.timestamp) {
    const t = keepTs && typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    out.timestamp = Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
  }
  const ft = str(e.footer && e.footer.text, 2048); if (ft) out.footer = { text: ft };
  const an = str(e.author && e.author.name, 256); if (an) out.author = { name: an };
  const th = url(e.thumbnail && e.thumbnail.url); if (th) out.thumbnail = { url: th };
  const im = url(e.image && e.image.url); if (im) out.image = { url: im };
  if (Array.isArray(e.fields)) {
    const f = e.fields
      .slice(0, 25)
      .map((x) => ({ name: str(x && x.name, 256), value: str(x && x.value, 1024), inline: !!(x && x.inline) }))
      .filter((x) => x.name && x.value);
    if (f.length) out.fields = f;
  }
  return Object.keys(out).length ? out : null;
}

// ---- yardımcılar ----
async function fetchAllMembers(g) {
  let all = [];
  let after = "0";
  for (let i = 0; i < 10; i++) {
    const page = await discord(`/guilds/${g}/members?limit=1000&after=${after}`);
    all = all.concat(page);
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return all;
}

// Son N dakikada katılıp rolü olmayanlara rol ver
async function syncAutoRole(g, roleId, windowMin, includeBots) {
  if (!isId(roleId)) throw httpErr(400, "Geçersiz rol");
  const roles = await discord(`/guilds/${g}/roles`);
  const role = roles.find((r) => r.id === roleId);
  if (!role || role.id === g) throw httpErr(400, "Rol bulunamadı");
  if (role.managed) throw httpErr(400, "Bot/entegrasyon rolleri verilemez");
  const since = Date.now() - Math.min(Math.max(Number(windowMin) || 60, 1), 60 * 24 * 7) * 60000;
  const all = await fetchAllMembers(g);
  const targets = all.filter(
    (m) => m.joined_at && Date.parse(m.joined_at) >= since && !m.roles.includes(roleId) && (includeBots || !m.user.bot)
  );
  const LIMIT = 25; // tek istekte en fazla (Vercel süre sınırı için)
  let given = 0, failed = 0, error = null;
  for (const m of targets.slice(0, LIMIT)) {
    try {
      await discord(`/guilds/${g}/members/${m.user.id}/roles/${roleId}`, "PUT", undefined, "Otomatik rol (yeni üye)");
      given++;
    } catch (e) {
      failed++;
      error = e.message;
      if (e.status === 403) break;
    }
    await sleep(120);
  }
  return { checked: all.length, matched: targets.length, given, failed, remaining: Math.max(targets.length - LIMIT, 0), error, role: role.name };
}

// ---- Discord etkileşimleri (ticket butonları) ----
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
function verifyDiscord(raw, sig, ts) {
  try {
    if (!process.env.DISCORD_PUBLIC_KEY || !sig || !ts) return false;
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519, Buffer.from(process.env.DISCORD_PUBLIC_KEY, "hex")]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(ts + raw), key, Buffer.from(sig, "hex"));
  } catch { return false; }
}

// VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | READ_MESSAGE_HISTORY
const TICKET_PERMS = String(1024 + 2048 + 16384 + 32768 + 65536);
const ephemeral = (content, extra = {}) => ({ type: 4, data: { content, flags: 64, ...extra } });

async function handleInteraction(i, g) {
  if (i.type === 1) return { type: 1 }; // PING
  if (i.type !== 3 || !i.data || typeof i.data.custom_id !== "string") return ephemeral("Desteklenmeyen işlem.");
  if (i.guild_id !== g) return ephemeral("Bu panel bu sunucu için ayarlanmamış.");
  const user = i.member && i.member.user;
  if (!user) return ephemeral("Kullanıcı bilgisi alınamadı.");
  const [kind, cat, staff] = i.data.custom_id.split(":");

  try {
    // --- bilet aç ---
    if (kind === "tk_open") {
      const all = await discord(`/guilds/${g}/channels`);
      const exist = all.find((c) => typeof c.topic === "string" && c.topic.startsWith(`ticket:${user.id}:`));
      if (exist) return ephemeral(`Zaten açık bir biletin var: <#${exist.id}>`);

      const clean = (user.username || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || user.id.slice(-6);
      const staffOk = isId(staff);
      const overwrites = [
        { id: g, type: 0, deny: "1024" },
        { id: user.id, type: 1, allow: TICKET_PERMS },
        { id: i.application_id, type: 1, allow: TICKET_PERMS },
      ];
      if (staffOk) overwrites.push({ id: staff, type: 0, allow: TICKET_PERMS });

      const ch = await discord(
        `/guilds/${g}/channels`,
        "POST",
        {
          name: `bilet-${clean}`,
          type: 0,
          parent_id: isId(cat) ? cat : undefined,
          topic: `ticket:${user.id}:${staffOk ? staff : 0}`,
          permission_overwrites: overwrites,
        },
        `Ticket: ${user.username}`
      );
      await discord(`/channels/${ch.id}/messages`, "POST", {
        content: `<@${user.id}>${staffOk ? ` <@&${staff}>` : ""}`,
        allowed_mentions: { users: [user.id], roles: staffOk ? [staff] : [] },
        embeds: [{
          title: "🎫 Destek talebi",
          description: "Sorununu buraya yaz, yetkililer en kısa sürede ilgilenecek.\nİşin bitince aşağıdaki butonla bileti kapatabilirsin.",
          color: 0xffc400,
        }],
        components: [{ type: 1, components: [{ type: 2, style: 4, label: "Bileti kapat", emoji: { name: "🔒" }, custom_id: "tk_close" }] }],
      });
      return ephemeral(`Biletin açıldı: <#${ch.id}>`);
    }

    // --- kapatma için onay iste / onayla ---
    if (kind === "tk_close" || kind === "tk_confirm") {
      const ch = await discord(`/channels/${i.channel_id}`);
      if (typeof ch.topic !== "string" || !ch.topic.startsWith("ticket:")) return ephemeral("Bu kanal bir bilet değil.");
      const [, opener, staffRole] = ch.topic.split(":");
      const perms = BigInt(i.member.permissions || "0");
      const allowed =
        user.id === opener ||
        (isId(staffRole) && (i.member.roles || []).includes(staffRole)) ||
        (perms & 0x8n) !== 0n || // Administrator
        (perms & 0x10n) !== 0n;  // Manage Channels
      if (!allowed) return ephemeral("Bu bileti kapatma yetkin yok.");

      if (kind === "tk_close") {
        return ephemeral("Bu bileti kapatmak istediğine emin misin? Kanal silinecek.", {
          components: [{ type: 1, components: [{ type: 2, style: 4, label: "Evet, kapat", custom_id: "tk_confirm" }] }],
        });
      }
      await discord(`/channels/${ch.id}`, "DELETE", undefined, `Ticket kapatıldı: ${user.username}`);
      return { type: 7, data: { content: "Bilet kapatıldı.", components: [] } };
    }
  } catch (e) {
    return ephemeral(`İşlem başarısız: ${e.message}\n(Botun Kanalları Yönet ve Rolleri Yönet izinlerini kontrol et.)`);
  }
  return ephemeral("Bilinmeyen işlem.");
}

module.exports = async (req, res) => {
  const M = req.method;
  const q = new URL(req.url, "http://localhost").searchParams;
  const a = q.get("a");
  const g = process.env.GUILD_ID;

  if (!g || !process.env.DISCORD_TOKEN) {
    return res.status(500).json({ error: "Sunucu ayarları eksik (DISCORD_TOKEN / GUILD_ID)" });
  }

  const raw = ["POST", "PUT", "PATCH", "DELETE"].includes(M) ? await readRaw(req) : "";
  let B = {};
  try { B = raw ? JSON.parse(raw) : {}; } catch { B = {}; }
  if (!B || typeof B !== "object") B = {};

  // ---- Discord'dan gelen butonlar (şifre yerine imza doğrulanır) ----
  if (a === "interactions" && M === "POST") {
    if (!verifyDiscord(raw, req.headers["x-signature-ed25519"], req.headers["x-signature-timestamp"])) {
      return res.status(401).send("invalid request signature");
    }
    return res.json(await handleInteraction(B, g));
  }

  // ---- zamanlanmış görev (Vercel Cron) ----
  const isCron = a === "cron" && M === "GET";
  if (isCron) {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "Yetkisiz" });
    if (!process.env.AUTO_ROLE_ID) return res.json({ ok: true, skipped: "AUTO_ROLE_ID tanımlı değil" });
    try {
      return res.json(await syncAutoRole(g, process.env.AUTO_ROLE_ID, Number(process.env.AUTO_ROLE_WINDOW_MIN) || 1500, false));
    } catch (e) {
      return res.status(e.status === 401 ? 502 : e.status || 500).json({ error: e.message });
    }
  }

  if (req.headers["x-panel-password"] !== process.env.PANEL_PASSWORD) {
    return res.status(401).json({ error: "Şifre yanlış" });
  }

  // kanalın bu sunucuya ait olduğunu doğrula
  const guildChannel = async (c) => {
    if (!isId(c)) throw httpErr(400, "Geçersiz kanal");
    const ch = await discord(`/channels/${c}`);
    if (ch.guild_id !== g) throw httpErr(403, "Bu kanal bu sunucuya ait değil");
    return ch;
  };

  try {
    // ---- sunucu bilgisi ----
    if (a === "guild" && M === "GET") {
      const [s, me] = await Promise.all([discord(`/guilds/${g}?with_counts=true`), discord("/users/@me").catch(() => null)]);
      return res.json({
        id: s.id,
        name: s.name,
        icon: s.icon,
        members: s.approximate_member_count,
        online: s.approximate_presence_count,
        boostTier: s.premium_tier,
        boosts: s.premium_subscription_count,
        botId: me ? me.id : null,
      });
    }

    // ---- roller ----
    if (a === "roles" && M === "GET") {
      const roles = await discord(`/guilds/${g}/roles`);
      return res.json(
        roles
          .filter((r) => r.id !== g)
          .sort((x, y) => y.position - x.position)
          .map((r) => ({ id: r.id, name: r.name, color: r.color, managed: r.managed }))
      );
    }

    // ---- üyeler ----
    if (a === "members" && M === "GET") {
      const all = await fetchAllMembers(g);
      return res.json(
        all.map((m) => ({
          id: m.user.id,
          username: m.user.username,
          globalName: m.user.global_name,
          nick: m.nick,
          avatar: m.user.avatar,
          bot: !!m.user.bot,
          roles: m.roles,
          joinedAt: m.joined_at,
          timeoutUntil: m.communication_disabled_until || null,
        }))
      );
    }

    // ---- kanallar ----
    if (a === "channels" && M === "GET") {
      const list = await discord(`/guilds/${g}/channels`);
      const cats = {};
      list.filter((c) => c.type === 4).forEach((c) => (cats[c.id] = { name: c.name, pos: c.position }));
      return res.json(
        list
          .filter((c) => [0, 5, 2, 13].includes(c.type))
          .map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            category: c.parent_id && cats[c.parent_id] ? cats[c.parent_id].name : null,
            catPos: c.parent_id && cats[c.parent_id] ? cats[c.parent_id].pos : -1,
            position: c.position,
          }))
          .sort((x, y) => x.catPos - y.catPos || x.position - y.position)
      );
    }

    // ---- kategoriler (ticket için) ----
    if (a === "categories" && M === "GET") {
      const list = await discord(`/guilds/${g}/channels`);
      return res.json(list.filter((c) => c.type === 4).sort((x, y) => x.position - y.position).map((c) => ({ id: c.id, name: c.name })));
    }

    // ---- rol ver / al ----
    if (a === "role") {
      const m = q.get("m");
      const r = q.get("r");
      if (!isId(m) || !isId(r)) throw httpErr(400, "Geçersiz istek");
      if (M === "PUT") return res.json(await discord(`/guilds/${g}/members/${m}/roles/${r}`, "PUT"));
      if (M === "DELETE") return res.json(await discord(`/guilds/${g}/members/${m}/roles/${r}`, "DELETE"));
    }

    // ---- takma ad ----
    if (a === "nick" && M === "PATCH") {
      const m = q.get("m");
      if (!isId(m)) throw httpErr(400, "Geçersiz istek");
      const nick = str(B.nick, 32) || null;
      return res.json(await discord(`/guilds/${g}/members/${m}`, "PATCH", { nick }));
    }

    // ---- kullanıcı sorgula (ID ile) ----
    if (a === "user" && M === "GET") {
      const id = q.get("id");
      if (!isId(id)) throw httpErr(400, "Geçersiz kullanıcı ID'si");
      const u = await discord(`/users/${id}`);
      return res.json({ id: u.id, username: u.username, globalName: u.global_name, avatar: u.avatar, bot: !!u.bot });
    }

    // ---- özel mesaj (DM) ----
    if (a === "dm" && M === "POST") {
      if (!isId(B.userId)) throw httpErr(400, "Geçersiz kullanıcı ID'si");
      const text = typeof B.content === "string" ? B.content.trim() : "";
      if (!text) throw httpErr(400, "Mesaj boş olamaz");
      if (text.length > 2000) throw httpErr(400, "Mesaj 2000 karakteri aşıyor");
      const dm = await discord(`/users/@me/channels`, "POST", { recipient_id: B.userId });
      const msg = await discord(`/channels/${dm.id}/messages`, "POST", { content: text });
      return res.json({ ok: true, id: msg.id });
    }

    // ---- kanala mesaj / embed / duyuru gönder ----
    if (a === "send" && M === "POST") {
      const ch = await guildChannel(B.channel);
      let ping = "";
      if (B.ping === "everyone") ping = "@everyone";
      else if (B.ping === "here") ping = "@here";
      else if (B.ping === "role" && isId(B.pingRole)) ping = `<@&${B.pingRole}>`;
      const content = [ping, typeof B.content === "string" ? B.content.trim() : ""].filter(Boolean).join("\n");
      if (content.length > 2000) throw httpErr(400, "Mesaj 2000 karakteri aşıyor");
      const embed = cleanEmbed(B.embed);
      if (!content && !embed) throw httpErr(400, "Gönderilecek bir içerik yok");
      const payload = {};
      if (content) payload.content = content;
      if (embed) payload.embeds = [embed];
      const msg = await discord(`/channels/${ch.id}/messages`, "POST", payload);
      let published = false;
      if (B.crosspost && ch.type === 5) {
        try {
          await discord(`/channels/${ch.id}/messages/${msg.id}/crosspost`, "POST");
          published = true;
        } catch { /* yayınlama başarısız olabilir, mesaj yine de gönderildi */ }
      }
      return res.json({ ok: true, id: msg.id, published, url: `https://discord.com/channels/${g}/${ch.id}/${msg.id}` });
    }

    // ---- kanal mesajlarını getir ----
    if (a === "messages" && M === "GET") {
      const ch = await guildChannel(q.get("c"));
      let path = `/channels/${ch.id}/messages?limit=100`;
      const before = q.get("before");
      if (isId(before)) path += `&before=${before}`;
      const list = await discord(path);
      return res.json({
        channel: { id: ch.id, name: ch.name, type: ch.type },
        messages: list.map((m) => ({
          id: m.id,
          type: m.type,
          content: m.content,
          timestamp: m.timestamp,
          edited: m.edited_timestamp,
          pinned: m.pinned,
          author: {
            id: m.author.id,
            username: m.author.username,
            globalName: m.author.global_name,
            avatar: m.author.avatar,
            bot: !!m.author.bot,
          },
          attachments: (m.attachments || []).map((x) => ({
            url: x.url,
            name: x.filename,
            type: x.content_type || "",
            size: x.size,
          })),
          embeds: (m.embeds || []).length,
          embedsRaw: (m.embeds || []).filter((e) => e.type === "rich"),
          reactions: (m.reactions || []).map((r) => ({ name: r.emoji.name, id: r.emoji.id, count: r.count, me: !!r.me })),
          poll: !!m.poll,
          stickers: (m.sticker_items || []).length,
          reply: !!m.message_reference,
        })),
      });
    }

    // ---- tek mesaj sil ----
    if (a === "msg" && M === "DELETE") {
      const c = q.get("c");
      const id = q.get("id");
      if (!isId(c) || !isId(id)) throw httpErr(400, "Geçersiz istek");
      return res.json(await discord(`/channels/${c}/messages/${id}`, "DELETE"));
    }

    // ---- toplu mesaj sil (14 günden yeni, 2-100 adet) ----
    if (a === "bulk" && M === "POST") {
      const ch = await guildChannel(B.channel);
      const ids = Array.isArray(B.ids) ? [...new Set(B.ids.filter(isId))] : [];
      if (ids.length < 2 || ids.length > 100) throw httpErr(400, "Toplu silme 2 ile 100 mesaj arasında olmalı");
      const limit = Date.now() - 14 * 86400000 + 60000;
      if (ids.some((id) => snowTime(id) < limit)) throw httpErr(400, "14 günden eski mesajlar toplu silinemez");
      await discord(`/channels/${ch.id}/messages/bulk-delete`, "POST", { messages: ids });
      return res.json({ ok: true, deleted: ids.length });
    }

    // =====================  MODERASYON  =====================

    // ---- kick / ban / unban / timeout ----
    if (a === "mod" && M === "POST") {
      const id = B.userId;
      if (!isId(id)) throw httpErr(400, "Geçersiz kullanıcı ID'si");
      const reason = str(B.reason, 400) || "Web panel";
      if (B.op === "kick") {
        await discord(`/guilds/${g}/members/${id}`, "DELETE", undefined, reason);
        return res.json({ ok: true });
      }
      if (B.op === "ban") {
        const days = Math.min(Math.max(parseInt(B.deleteDays) || 0, 0), 7);
        await discord(`/guilds/${g}/bans/${id}`, "PUT", { delete_message_seconds: days * 86400 }, reason);
        return res.json({ ok: true });
      }
      if (B.op === "unban") {
        await discord(`/guilds/${g}/bans/${id}`, "DELETE", undefined, reason);
        return res.json({ ok: true });
      }
      if (B.op === "timeout") {
        const min = Math.min(Math.max(parseInt(B.minutes) || 0, 0), 40320); // en fazla 28 gün
        const until = min ? new Date(Date.now() + min * 60000).toISOString() : null;
        await discord(`/guilds/${g}/members/${id}`, "PATCH", { communication_disabled_until: until }, reason);
        return res.json({ ok: true, until });
      }
      throw httpErr(400, "Geçersiz işlem");
    }

    // ---- yasak listesi ----
    if (a === "bans" && M === "GET") {
      let all = [];
      let after = "0";
      for (let i = 0; i < 5; i++) {
        const page = await discord(`/guilds/${g}/bans?limit=1000&after=${after}`);
        all = all.concat(page);
        if (page.length < 1000) break;
        after = page[page.length - 1].user.id;
      }
      return res.json(
        all.map((b) => ({
          id: b.user.id,
          username: b.user.username,
          globalName: b.user.global_name,
          avatar: b.user.avatar,
          bot: !!b.user.bot,
          reason: b.reason || null,
        }))
      );
    }

    // =====================  BOT MESAJLARI  =====================

    // ---- mesaj düzenle (sadece botun kendi mesajları) ----
    if (a === "edit" && M === "PATCH") {
      const ch = await guildChannel(B.channel);
      if (!isId(B.id)) throw httpErr(400, "Geçersiz mesaj");
      const payload = {};
      if (typeof B.content === "string") {
        if (B.content.length > 2000) throw httpErr(400, "Mesaj 2000 karakteri aşıyor");
        payload.content = B.content;
      }
      if (B.embed === null) payload.embeds = [];
      else if (B.embed) {
        const e = cleanEmbed(B.embed, true);
        if (!e) throw httpErr(400, "Embed boş olamaz");
        payload.embeds = [e];
      }
      if (!Object.keys(payload).length) throw httpErr(400, "Değiştirilecek bir şey yok");
      const m = await discord(`/channels/${ch.id}/messages/${B.id}`, "PATCH", payload);
      return res.json({ ok: true, id: m.id });
    }

    // ---- tepki ekle / kendi tepkini kaldır ----
    if (a === "react" && (M === "PUT" || M === "DELETE")) {
      const ch = await guildChannel(B.channel);
      if (!isId(B.id)) throw httpErr(400, "Geçersiz mesaj");
      const emoji = typeof B.emoji === "string" ? B.emoji.trim() : "";
      if (!emoji || emoji.length > 64 || /[\/\\?#]/.test(emoji)) throw httpErr(400, "Geçersiz emoji");
      return res.json(await discord(`/channels/${ch.id}/messages/${B.id}/reactions/${encodeURIComponent(emoji)}/@me`, M));
    }

    // ---- sabitle / sabitlemeyi kaldır ----
    if (a === "pin" && (M === "PUT" || M === "DELETE")) {
      const ch = await guildChannel(B.channel);
      if (!isId(B.id)) throw httpErr(400, "Geçersiz mesaj");
      return res.json(await discord(`/channels/${ch.id}/pins/${B.id}`, M));
    }

    // =====================  ANKET & ETKİNLİK  =====================

    // ---- anket gönder ----
    if (a === "poll" && M === "POST") {
      const ch = await guildChannel(B.channel);
      const question = str(B.question, 300);
      if (!question) throw httpErr(400, "Anket sorusu boş olamaz");
      const answers = (Array.isArray(B.answers) ? B.answers : [])
        .map((x) => str(x, 55))
        .filter(Boolean)
        .slice(0, 10)
        .map((text) => ({ poll_media: { text } }));
      if (answers.length < 2) throw httpErr(400, "En az 2 seçenek gerekli");
      const duration = Math.min(Math.max(parseInt(B.hours) || 24, 1), 768);
      const payload = { poll: { question: { text: question }, answers, duration, allow_multiselect: !!B.multi } };
      const content = str(B.content, 2000);
      if (content) payload.content = content;
      const msg = await discord(`/channels/${ch.id}/messages`, "POST", payload);
      return res.json({ ok: true, id: msg.id, url: `https://discord.com/channels/${g}/${ch.id}/${msg.id}` });
    }

    // ---- etkinlikler ----
    if (a === "events" && M === "GET") {
      const list = await discord(`/guilds/${g}/scheduled-events?with_user_count=true`);
      return res.json(
        list.map((e) => ({
          id: e.id,
          name: e.name,
          description: e.description || "",
          start: e.scheduled_start_time,
          end: e.scheduled_end_time,
          type: e.entity_type,
          status: e.status,
          count: e.user_count ?? null,
          channelId: e.channel_id,
          location: e.entity_metadata ? e.entity_metadata.location : null,
        }))
      );
    }
    if (a === "event" && M === "POST") {
      const name = str(B.name, 100);
      if (!name) throw httpErr(400, "Etkinlik adı boş olamaz");
      const start = Date.parse(B.start);
      const end = B.end ? Date.parse(B.end) : NaN;
      if (Number.isNaN(start)) throw httpErr(400, "Başlangıç zamanı geçersiz");
      if (start < Date.now() + 30000) throw httpErr(400, "Başlangıç zamanı gelecekte olmalı");
      if (B.end && (Number.isNaN(end) || end <= start)) throw httpErr(400, "Bitiş zamanı başlangıçtan sonra olmalı");
      const payload = {
        name,
        privacy_level: 2,
        scheduled_start_time: new Date(start).toISOString(),
      };
      const desc = str(B.description, 1000);
      if (desc) payload.description = desc;
      if (B.type === "external") {
        const location = str(B.location, 100);
        if (!location) throw httpErr(400, "Dış mekan etkinliği için konum gerekli");
        if (!B.end) throw httpErr(400, "Dış mekan etkinliği için bitiş zamanı gerekli");
        payload.entity_type = 3;
        payload.entity_metadata = { location };
      } else {
        const ch = await guildChannel(B.channel);
        if (B.type === "stage") {
          if (ch.type !== 13) throw httpErr(400, "Sahne etkinliği için bir sahne kanalı seç");
          payload.entity_type = 1;
        } else {
          if (ch.type !== 2) throw httpErr(400, "Ses etkinliği için bir ses kanalı seç");
          payload.entity_type = 2;
        }
        payload.channel_id = ch.id;
      }
      if (B.end) payload.scheduled_end_time = new Date(end).toISOString();
      const ev = await discord(`/guilds/${g}/scheduled-events`, "POST", payload);
      return res.json({ ok: true, id: ev.id, url: `https://discord.com/events/${g}/${ev.id}` });
    }
    if (a === "event" && M === "DELETE") {
      const id = q.get("id");
      if (!isId(id)) throw httpErr(400, "Geçersiz etkinlik");
      return res.json(await discord(`/guilds/${g}/scheduled-events/${id}`, "DELETE"));
    }

    // =====================  TICKET  =====================

    // ---- bilet panelini (butonlu mesaj) gönder ----
    if (a === "ticketpanel" && M === "POST") {
      const ch = await guildChannel(B.channel);
      const cat = await guildChannel(B.category);
      if (cat.type !== 4) throw httpErr(400, "Biletlerin açılacağı bir kategori seç");
      const staff = isId(B.staffRole) ? B.staffRole : "0";
      const embed =
        cleanEmbed({
          title: B.title || "🎫 Destek",
          description: B.description || "Yardıma mı ihtiyacın var? Aşağıdaki butona basarak özel bir destek bileti aç.",
          color: Number.isInteger(B.color) ? B.color : 0xffc400,
        });
      const label = str(B.button, 80) || "Bilet Aç";
      const msg = await discord(`/channels/${ch.id}/messages`, "POST", {
        embeds: [embed],
        components: [{ type: 1, components: [{ type: 2, style: 1, label, emoji: { name: "🎫" }, custom_id: `tk_open:${cat.id}:${staff}` }] }],
      });
      return res.json({ ok: true, id: msg.id, url: `https://discord.com/channels/${g}/${ch.id}/${msg.id}` });
    }

    // ---- açık biletler ----
    if (a === "tickets" && M === "GET") {
      const list = await discord(`/guilds/${g}/channels`);
      return res.json(
        list
          .filter((c) => typeof c.topic === "string" && c.topic.startsWith("ticket:"))
          .map((c) => ({ id: c.id, name: c.name, opener: c.topic.split(":")[1], created: snowTime(c.id) }))
          .sort((x, y) => y.created - x.created)
      );
    }

    // ---- bileti panelden kapat ----
    if (a === "ticket" && M === "DELETE") {
      const ch = await guildChannel(q.get("c"));
      if (typeof ch.topic !== "string" || !ch.topic.startsWith("ticket:")) throw httpErr(400, "Bu kanal bir bilet değil");
      return res.json(await discord(`/channels/${ch.id}`, "DELETE", undefined, "Ticket panelden kapatıldı"));
    }

    // =====================  OTOMATİK ROL  =====================

    if (a === "autorole" && M === "POST") {
      return res.json(await syncAutoRole(g, B.roleId, B.minutes, !!B.includeBots));
    }

    return res.status(400).json({ error: "Geçersiz istek" });
  } catch (e) {
    // Discord'un 401'i (token hatası) ile panel şifresi hatasını karıştırma
    const status = e.status === 401 ? 502 : e.status || 500;
    return res.status(status).json({ error: e.message, code: e.code });
  }
};

// Ham gövde gerekli (Discord imzası): Vercel'in otomatik JSON ayrıştırmasını kapat
module.exports.config = { api: { bodyParser: false } };
