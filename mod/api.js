import { appHome, readTextFile } from "herdr";
import { API_URL } from "./linear.js";
import { shellEnv } from "./env.js";

export const NO_KEY = "No Linear API key. Add it to ~/.config/herdr-app/linear.json or set LINEAR_API_KEY.";

export async function loadApiKey() {
  const text = await readTextFile(`${appHome()}/linear.json`).catch(() => null);
  if (text != null) {
    let raw;
    try { raw = JSON.parse(text); } catch { throw new Error("linear.json is not valid JSON"); }
    if (typeof raw?.apiKey === "string" && raw.apiKey.trim()) return raw.apiKey.trim();
  }
  const fromShell = await shellEnv("LINEAR_API_KEY");
  if (!fromShell) throw new Error(NO_KEY);
  return fromShell;
}

export async function gql(apiKey, query, variables = {}) {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.text();
  if (r.status === 401) throw new Error("Invalid Linear API key");
  let json;
  try { json = JSON.parse(body); } catch { throw new Error(`Linear answered ${r.status}`); }
  const error = json?.errors?.[0];
  const message = error?.extensions?.userPresentableMessage ?? error?.message;
  if (message) throw new Error(/authenticat/i.test(message) ? "Invalid Linear API key" : message);
  if (!r.ok) throw new Error(`Linear answered ${r.status}`);
  return json.data;
}
