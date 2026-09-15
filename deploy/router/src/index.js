// Fly Heaven router for https://demo.aanandagiri.com.np/fly-heaven*
//
// Like fly-chess-router, it prefers the laptop and falls back to the always-on
// lucy box. Unlike Fly Chess, the app is stateful: every fly is a brain process
// on one server, and a page's session token belongs to that server. So a page
// stays with the server that answered its page load (the fh_backend cookie) and
// moves only when that server stops answering; the page then fetches the new
// server's token (web/main.js), and its flies start over there.

const BACKENDS = {
  laptop: "demo-gpu.aanandagiri.com.np", // tunnel laptop-demos -> 127.0.0.1:8935
  lucy: "demo-cpu.aanandagiri.com.np", // tunnel lucy-demos -> 127.0.0.1:8934
};
const PREFERRED = ["laptop", "lucy"];

// 530: Cloudflare can't reach the tunnel (its connector is offline).
// 502/503/504: the tunnel is up but the app behind it isn't answering.
const UNAVAILABLE = new Set([502, 503, 504, 530]);

// How long to wait for a backend's response headers before trying the next one.
// A suspended laptop can look connected for a while; every app response is quick.
const TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1024; // the API's requests carry no body
const PAGE = "/fly-heaven/";
const COOKIE = "fh_backend";
const COOKIE_ATTRIBUTES = "Path=/fly-heaven; Secure; HttpOnly; SameSite=Lax";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const pinned = readCookie(request.headers.get("Cookie"), COOKIE);
    // A page load chooses afresh, so pages return to the laptop once it's back.
    const order = url.pathname !== PAGE && Object.hasOwn(BACKENDS, pinned)
      ? [pinned, ...PREFERRED.filter((name) => name !== pinned)]
      : PREFERRED;

    let body = null;
    if (request.body !== null) {
      if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) {
        return new Response("Request body too large", { status: 413 });
      }
      // Buffered (and bounded) so the same body can be replayed to the fallback.
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) {
        return new Response("Request body too large", { status: 413 });
      }
    }

    const { response, backend } = await forward(request, url, body, order);
    if (backend && backend !== pinned) {
      response.headers.append("Set-Cookie", `${COOKIE}=${backend}; ${COOKIE_ATTRIBUTES}`);
    }
    return response;
  },
};

async function forward(request, url, body, order) {
  // Adding or removing a fly isn't idempotent: after a timeout the first
  // backend may already have done it, so only reads retry then.
  const idempotent = request.method === "GET" || request.method === "HEAD";

  for (const [index, name] of order.entries()) {
    const isLast = index === order.length - 1;
    const target = new URL(url);
    target.hostname = BACKENDS[name];
    const controller = new AbortController();
    let timedOut = false;
    const timer = isLast ? undefined : setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);
    try {
      const response = await fetch(target, {
        method: request.method,
        headers: request.headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      if (!isLast && UNAVAILABLE.has(response.status)) {
        console.log(JSON.stringify({ message: "backend unavailable", backend: name, status: response.status, path: url.pathname }));
        await response.body?.cancel();
        continue;
      }
      return { response: relay(response, name, url), backend: name };
    } catch (error) {
      console.log(JSON.stringify({ message: "backend unreachable", backend: name, timedOut, error: String(error), path: url.pathname }));
      if (timedOut && !idempotent) break;
    } finally {
      // Only the wait for headers is bounded; a response already streaming is left alone.
      clearTimeout(timer);
    }
  }

  const offline = new Response("Fly Heaven is offline right now: none of its servers answered. Please try again in a minute.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "60", "Cache-Control": "no-store" },
  });
  return { response: offline, backend: null };
}

function relay(response, name, publicUrl) {
  const headers = new Headers(response.headers);
  headers.set("X-Fly-Heaven-Backend", name);
  // Absolute redirects are built from the Host the backend saw; point them back at the public hostname.
  const location = headers.get("Location");
  if (location) {
    const target = new URL(location, publicUrl);
    if (Object.values(BACKENDS).includes(target.hostname)) {
      target.host = publicUrl.host;
      headers.set("Location", target.href);
    }
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function readCookie(header, name) {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}
