// public/js/auth.js
function apiUrl(path) {
  const base = (window.API_BASE || "").replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

function getToken() {
  return localStorage.getItem("kyanz_token") || "";
}

function setToken(token) {
  localStorage.setItem("kyanz_token", token);
}

function clearToken() {
  localStorage.removeItem("kyanz_token");
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };

  if (!headers["Content-Type"] && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(apiUrl(path), { ...options, headers });
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const data = isJson ? await res.json().catch(() => ({})) : await res.text();

  if (!res.ok) {
    const msg = data?.msg || data?.error || (typeof data === "string" ? data : "Request failed");
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
