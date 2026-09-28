const out = document.getElementById("out");
const get = async (path) => {
  const res = await fetch(path);
  return { path, status: res.status, body: await res.json() };
};
try {
  const meta = await get("/api/meta");
  const next = meta.body.state === "needs-db" ? "/api/candidates" : "/api/tables";
  out.textContent = JSON.stringify([meta, await get(next)], null, 2);
} catch (err) {
  out.textContent = String(err);
}
