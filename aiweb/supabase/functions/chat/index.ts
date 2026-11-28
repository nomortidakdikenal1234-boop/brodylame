// Supabase Edge Function "chat". Deploy: supabase functions deploy chat --no-verify-jwt
// (pemeriksaan login dilakukan di dalam fungsi ini lewat auth.getUser)
// Sky Lite -> Groq, Sky Med -> Gemini, Sky Pro dan Sky Ultra -> OpenAI. Key diatur di panel admin.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const NEED: Record<string, number> = { "Sky Lite": 0, "Sky Med": 0, "Sky Pro": 1, "Sky Ultra": 2 };
const SLOT: Record<string, string> = { "Sky Lite": "lite", "Sky Med": "med", "Sky Pro": "pro", "Sky Ultra": "ultra" };
const PROV: Record<string, string> = { lite: "groq", med: "gemini", pro: "openai", ultra: "openai" };
const DEF: Record<string, string> = { lite: "llama-3.3-70b-versatile", med: "gemini-2.5-flash", pro: "gpt-4o-mini", ultra: "gpt-4o" };
const OAI: Record<string, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
};
const BASE = "Kamu adalah Sky AI, asisten yang ramah, jujur, dan ringkas.";
const CODE = `Kamu sedang dalam mode Code.

ATURAN OUTPUT
- Jika diminta membuat website, aplikasi web, atau halaman: tulis SATU file HTML lengkap (<!DOCTYPE html>) dengan semua CSS di dalam <style> dan semua JavaScript di dalam <script> pada file yang sama. JANGAN memecahnya menjadi style.css atau script.js. JANGAN memakai file, gambar, font, atau library dari luar (tanpa CDN). Letakkan semuanya dalam SATU blok \`\`\`html.
- Hasilnya harus langsung berjalan dan fungsional: tombol, filter, form, keranjang, dan sebagainya benar-benar bekerja lewat JavaScript. Simpan data di variabel JavaScript, bukan di localStorage.
- Setelah kode, tulis bagian singkat "Cara memakai".
- Untuk kode non-web, beri satu blok kode per file dengan nama file di baris sebelumnya.
- Buat kode ringkas (maksimal sekitar 350 baris) agar tidak terpotong.

DESAIN (hindari tampilan generik ala "AI slop")
- Pilih arah visual yang spesifik untuk topiknya, bukan template umum. Tentukan satu warna dominan dan satu aksen. Jangan memakai gradasi ungu-biru dan jangan memakai deretan kartu putih berbayang yang seragam.
- Tipografi: pakai font sistem yang punya karakter (misalnya Georgia atau serif lain untuk judul, sans-serif untuk isi), skala ukuran yang jelas, dan jarak antarbaris yang nyaman.
- Tata letak: grid yang rapi, hirarki visual yang jelas, ruang kosong yang disengaja, dan responsif untuk layar HP.
- Isi: tulis konten nyata sesuai topik (nama produk, harga, deskripsi yang masuk akal). Jangan memakai "Lorem ipsum", jangan memakai emoji sebagai ikon, jangan memakai kotak abu-abu sebagai gambar. Buat ilustrasi dengan CSS atau SVG inline.
- Hidup: beri status hover dan fokus, transisi halus 150 sampai 250 ms, animasi masuk yang halus, dan interaksi yang berguna. Jangan berlebihan.
- Hindari: semua teks rata tengah, tombol bergradien, judul klise seperti "Selamat Datang di ...", dan kartu identik yang diulang tanpa variasi.`;

type Msg = { role: "user" | "model"; text: string };
type Img = { mime: string; data: string };
const out = (c: number, b: unknown) =>
  new Response(JSON.stringify(b), { status: c, headers: { ...cors, "Content-Type": "application/json" } });

async function callGemini(key: string, model: string, sys: string, msgs: Msg[], imgs: Img[]) {
  const contents = msgs.map((m, i) => ({
    role: m.role,
    parts: [{ text: m.text }, ...(i === msgs.length - 1 ? imgs.map((x) => ({ inlineData: { mimeType: x.mime, data: x.data } })) : [])],
  }));
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: sys }] } }),
  });
  const d = await r.json();
  const t = (d?.candidates?.[0]?.content?.parts ?? []).map((x: any) => x.text ?? "").join("");
  return r.ok && t ? { text: t } : { err: "Gemini " + r.status + ": " + String(d?.error?.message ?? "tanpa jawaban") };
}

async function callOAI(prov: string, key: string, model: string, sys: string, msgs: Msg[], imgs: Img[]) {
  const messages: any[] = [{ role: "system", content: sys }];
  msgs.forEach((m, i) => {
    const role = m.role === "model" ? "assistant" : "user";
    if (i === msgs.length - 1 && imgs.length && prov === "openai") {
      messages.push({ role, content: [{ type: "text", text: m.text }, ...imgs.map((x) => ({ type: "image_url", image_url: { url: "data:" + x.mime + ";base64," + x.data } }))] });
    } else messages.push({ role, content: m.text });
  });
  const r = await fetch(OAI[prov], {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model, messages }),
  });
  const d = await r.json();
  const t = String(d?.choices?.[0]?.message?.content ?? "");
  return r.ok && t ? { text: t } : { err: prov + " " + r.status + ": " + String(d?.error?.message ?? "tanpa jawaban") };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return out(405, { error: "Metode tidak diizinkan." });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  const { data: u } = await sb.auth.getUser(jwt);
  if (!u?.user) return out(401, { error: "Silakan masuk terlebih dahulu." });
  const uid = u.user.id;

  let j: any;
  try { j = await req.json(); } catch { return out(400, { error: "Permintaan tidak valid." }); }
  const m = String(j?.model);
  if (!(m in NEED)) return out(400, { error: "Model tidak dikenal." });

  const { data: p } = await sb.from("profiles").select("plan,plan_expires_at,banned,ban_reason").eq("id", uid).maybeSingle();
  if (p?.banned) return out(403, { error: "Akun Anda sedang di-banned" + (p.ban_reason ? ": " + p.ban_reason : "") + "." });
  const active = !!p && p.plan !== "free" && (!p.plan_expires_at || new Date(p.plan_expires_at) > new Date());
  const rank = active ? ["free", "pro", "ultra"].indexOf(p!.plan) : 0;
  if (rank < NEED[m]) return out(403, { error: m + " khusus pelanggan " + (NEED[m] === 1 ? "Pro" : "Ultra") + "." });

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  if (ip) await sb.from("profiles").update({ ip, ip_at: new Date().toISOString() }).eq("id", uid);

  const { data: us } = await sb.rpc("usage_status", { uid });
  if (us && us.used >= us.limit) {
    const mins = Math.max(1, Math.ceil((new Date(us.reset_at).getTime() - Date.now()) / 60000));
    return out(429, { error: `Batas pemakaian tercapai (${us.limit} pesan per ${us.window} menit). Coba lagi dalam ${mins} menit.` });
  }

  const msgs: Msg[] = (Array.isArray(j.messages) ? j.messages : []).slice(-20).map((x: any) => ({
    role: x?.role === "model" ? "model" : "user",
    text: String(x?.text ?? "").slice(0, 30000),
  }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return out(400, { error: "Pesan tidak valid." });
  const imgs: Img[] = (Array.isArray(j.images) ? j.images : []).slice(0, 1).filter((x: any) =>
    x && ["image/png", "image/jpeg", "image/webp"].includes(x.mime) && typeof x.data === "string" &&
    x.data.length < 2_200_000 && /^[A-Za-z0-9+/=]+$/.test(x.data));

  const slot = SLOT[m], prov = PROV[slot];
  if (prov === "groq" && imgs.length) return out(400, { error: "Sky Lite belum mendukung foto. Pilih Sky Med, Sky Pro, atau Sky Ultra." });

  const lang = typeof j.lang === "string" && /^[\p{L}\s().,'-]{2,50}$/u.test(j.lang) ? j.lang : "";
  const { data: sp } = await sb.from("settings").select("value").eq("key", "system_prompt").maybeSingle();
  let sys = typeof sp?.value === "string" && sp.value.trim() ? sp.value : BASE;
  if (j.mode === "code") sys += "\n\n" + CODE;
  if (typeof j.project_id === "string" && /^[0-9a-f-]{36}$/.test(j.project_id)) {
    const { data: pr } = await sb.from("projects").select("name,goal").eq("id", j.project_id).eq("user_id", uid).maybeSingle();
    if (pr) sys += `\n\nKamu membantu menjalankan proyek "${pr.name}". Tujuan proyek: ${pr.goal}`;
  }
  if (lang) sys += "\nSelalu jawab dalam bahasa " + lang + ".";

  const { data: st } = await sb.from("settings").select("value").eq("key", "models").maybeSingle();
  const model = String(st?.value?.[slot] ?? DEF[slot]);
  if (!/^[\w.:-]{3,70}$/.test(model)) return out(500, { error: "Nama model tidak valid. Periksa di panel admin." });

  const { data: ks } = await sb.from("ai_keys").select("key").eq("provider", prov).eq("active", true);
  const keys = (ks ?? []).map((k: any) => k.key as string).sort(() => Math.random() - 0.5);
  if (!keys.length) return out(503, { error: "Belum ada API key untuk " + m + ". Hubungi admin." });

  let last = "";
  for (const k of keys) {
    try {
      const r = prov === "gemini" ? await callGemini(k, model, sys, msgs, imgs) : await callOAI(prov, k, model, sys, msgs, imgs);
      if ("text" in r && r.text) {
        await sb.from("usage").insert({ user_id: uid, model: m });
        const { data: us2 } = await sb.rpc("usage_status", { uid });
        return out(200, { text: r.text, usage: us2 });
      }
      last = (r as any).err;
    } catch { last = "Gagal menghubungi " + prov; }
  }
  return out(502, { error: "Semua API key gagal atau kuotanya habis. Coba lagi nanti.", detail: String(last).slice(0, 160) });
});
