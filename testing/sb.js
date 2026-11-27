(function () {
"use strict";
var C = window.SKY || {}, K = "sky.session", S = null;
C.url = String(C.url || "").replace(/\/(rest|auth|functions|storage)\/v1.*$/, "").replace(/\/+$/, "");
try { S = JSON.parse(localStorage.getItem(K)); } catch (e) {}
function ready() { if (!C.url || /GANTI/.test(C.url) || !C.key) throw new Error("Isi Project URL Supabase di config.js."); }
function save() { try { S ? localStorage.setItem(K, JSON.stringify(S)) : localStorage.removeItem(K); } catch (e) {} }
function hdr(t, x) { var h = { apikey: C.key, "Content-Type": "application/json" }; if (t) h.Authorization = "Bearer " + t; for (var k in x) h[k] = x[k]; return h; }
function parse(r) {
  return r.text().then(function (t) {
    var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) {}
    if (!r.ok) { var e = new Error((d && (d.error || d.msg || d.message || d.error_description)) || "Kesalahan " + r.status); e.status = r.status; throw e; }
    return d;
  });
}
function setS(d) { S = { a: d.access_token, r: d.refresh_token, x: Date.now() + (d.expires_in || 3600) * 1000 - 30000 }; save(); }
function token() {
  if (!S) return Promise.resolve(null);
  if (Date.now() < S.x) return Promise.resolve(S.a);
  return fetch(C.url + "/auth/v1/token?grant_type=refresh_token", { method: "POST", headers: hdr(), body: JSON.stringify({ refresh_token: S.r }) })
    .then(parse).then(function (d) { setS(d); return S.a; }, function () { S = null; save(); return null; });
}
function authed(fn) { return Promise.resolve().then(function () { ready(); return token(); }).then(fn); }
var back = function () { return encodeURIComponent(location.origin + location.pathname); };

var BAD = "Kode atau tautan tidak valid atau sudah kedaluwarsa.";
function who() {
  return token().then(function (t) {
    return t ? fetch(C.url + "/auth/v1/user", { headers: hdr(t) }).then(parse).catch(function () { return null; }) : null;
  });
}
function tryVerify(body, types) {
  var i = 0;
  function next(e) {
    if (i >= types.length) throw e;
    var b = { type: types[i++] }; for (var k in body) b[k] = body[k];
    return fetch(C.url + "/auth/v1/verify", { method: "POST", headers: hdr(), body: JSON.stringify(b) }).then(parse)
      .then(function (d) { if (!d || !d.access_token) throw new Error(BAD); setS(d); }, next);
  }
  return next(new Error(BAD));
}

window.sb = {
  init: function () {
    return Promise.resolve().then(function () {
      ready();
      var q = new URLSearchParams(location.search), th = q.get("token_hash");
      if (th) {
        var ty = q.get("type"); q.delete("token_hash"); q.delete("type");
        var qs = q.toString();
        history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
        return tryVerify({ token_hash: th }, ty ? [ty, "email", "signup", "magiclink"] : ["email", "signup", "magiclink"]).then(who);
      }
      var p = new URLSearchParams(location.hash.slice(1));
      if (p.get("access_token")) {
        setS({ access_token: p.get("access_token"), refresh_token: p.get("refresh_token"), expires_in: parseInt(p.get("expires_in"), 10) || 3600 });
        history.replaceState(null, "", location.pathname + location.search);
      } else if (p.get("error_description")) {
        history.replaceState(null, "", location.pathname + location.search);
        throw new Error(p.get("error_description"));
      }
      return who();
    });
  },
  login: function (email, password) {
    return Promise.resolve().then(function () {
      ready();
      return fetch(C.url + "/auth/v1/token?grant_type=password", { method: "POST", headers: hdr(), body: JSON.stringify({ email: email, password: password }) })
        .then(parse).then(function (d) { if (!d || !d.access_token) throw new Error("Email atau password salah."); setS(d); });
    });
  },
  verify: function (email, code) {
    return Promise.resolve().then(function () {
      ready();
      return tryVerify({ email: email, token: code }, ["email", "signup", "magiclink"]);
    });
  },
  magic: function (email, name, create) {
    return Promise.resolve().then(function () {
      ready();
      return fetch(C.url + "/auth/v1/otp?redirect_to=" + back(), { method: "POST", headers: hdr(), body: JSON.stringify({ email: email, create_user: create !== false, data: { name: name || "" } }) }).then(parse);
    });
  },
  oauth: function (p) {
    return Promise.resolve().then(function () {
      ready();
      return fetch(C.url + "/auth/v1/settings", { headers: { apikey: C.key } }).then(parse).catch(function () { return null; });
    }).then(function (st) {
      if (st && st.external && st.external[p] === false) throw new Error("Login " + p + " belum diaktifkan di Supabase (Authentication > Providers).");
      location.href = C.url + "/auth/v1/authorize?provider=" + encodeURIComponent(p) + "&redirect_to=" + back() + "&apikey=" + encodeURIComponent(C.key);
    });
  },
  out: function () {
    var t = S && S.a; S = null; save();
    if (t && C.url && !/GANTI/.test(C.url)) fetch(C.url + "/auth/v1/logout", { method: "POST", headers: hdr(t) }).catch(function () {});
  },
  rest: function (path, o) {
    o = o || {};
    return authed(function (t) {
      return fetch(C.url + "/rest/v1/" + path, { method: o.method || "GET", headers: hdr(t, o.headers), body: o.body ? JSON.stringify(o.body) : undefined }).then(parse);
    });
  },
  fn: function (name, body) {
    return authed(function (t) {
      if (!t) { var e = new Error("Silakan masuk terlebih dahulu."); e.status = 401; throw e; }
      return fetch(C.url + "/functions/v1/" + name, { method: "POST", headers: hdr(t), body: JSON.stringify(body) }).then(parse);
    });
  },
  upload: function (bucket, path, file) {
    return authed(function (t) {
      return fetch(C.url + "/storage/v1/object/" + bucket + "/" + path, { method: "POST", headers: { apikey: C.key, Authorization: "Bearer " + t, "Content-Type": file.type }, body: file }).then(parse);
    });
  },
  pub: function (bucket, path) { return C.url + "/storage/v1/object/public/" + bucket + "/" + path; }
};
})();
