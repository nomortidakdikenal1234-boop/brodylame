// Supabase Edge Function "chat". Deploy: supabase functions deploy chat
// Opsional: supabase secrets set ALLOWED_ORIGIN=https://namaanda.github.io
// SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY tersedia otomatis di Edge Function.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const NEED: Record<string, number> = { "Sky Lite": 0, "Sky Med": 0, "Sky Pro": 1, "Sky Ultra": 2 };
const SLOT: Record<string, string> = { "Sky Lite": "lite", "Sky Med": "med", "Sky Pro": "pro", "Sky Ultra": "ultra" };
const DEF: Record<string, string> = { lite: "gemini-2.5-flash-lite", med: "gemini-2.5-flash", pro: "gemini-2.5-pro", ultra: "gemini-2.5-pro" };
const out = (c: number, b: unknown) =>
  new Response(JSON.stringify(b), { status: c, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return out(405, { error: "Metode tidak diizinkan." });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  const { data: u } = await sb.auth.getUser(jwt);
  if (!u?.user) return out(401, { error: "Silakan masuk terlebih dahulu." });

  let j: any;
  try { j = await req.json(); } catch { return out(400, { error: "Permintaan tidak valid." }); }
  const m = String(j?.model);
  if (!(m in NEED)) return out(400, { error: "Model tidak dikenal." });

  const { data: p } = await sb.from("profiles").select("plan").eq("id", u.user.id).maybeSingle();
  const rank = ["free", "pro", "ultra"].indexOf(p?.plan ?? "free");
  if (rank < NEED[m]) return out(403, { error: m + " khusus pelanggan " + (NEED[m] === 1 ? "Pro" : "Ultra") + "." });

  const msgs = (Array.isArray(j.messages) ? j.messages : []).slice(-20).map((x: any) => ({
    role: x?.role === "model" ? "model" : "user",
    parts: [{ text: String(x?.text ?? "").slice(0, 4000) }],
  }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return out(400, { error: "Pesan tidak valid." });

  const { data: st } = await sb.from("settings").select("value").eq("key", "models").maybeSingle();
  const model = String(st?.value?.[SLOT[m]] ?? DEF[SLOT[m]]);
  if (!/^[\w.-]{3,60}$/.test(model)) return out(500, { error: "Nama model tidak valid. Periksa di panel admin." });

  const { data: ks } = await sb.from("ai_keys").select("key").eq("active", true);
  const keys = (ks ?? []).map((k: any) => k.key as string).sort(() => Math.random() - 0.5);
  if (!keys.length) return out(503, { error: "Belum ada API key. Hubungi admin." });

  for (const k of keys) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": k },
        body: JSON.stringify({ contents: msgs }),
      });
      const d = await r.json();
      const t = (d?.candidates?.[0]?.content?.parts ?? []).map((x: any) => x.text ?? "").join("");
      if (r.ok && t) return out(200, { text: t });
    } catch { /* coba key berikutnya */ }
  }
  return out(502, { error: "Semua API key gagal atau kuotanya habis. Coba lagi nanti." });
});
