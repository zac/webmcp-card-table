import { PRACTICE_CONTRACT, type TableView } from "../shared";
import { hashToken, randomToken } from "./crypto";
import { GameRoom, type RpcResult } from "./game-room";
import {
  assertInviteToken,
  assertRoomId,
  parseActionEnvelope,
  parseCreateRoom,
  readJson,
  RequestError,
} from "./validation";

export { GameRoom };

const SESSION_COOKIE = "card_table_session";

export default {
  async fetch(request, env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const url = new URL(request.url);
    let response: Response;

    try {
      response = await route(request, url, env);
    } catch (error) {
      response = errorResponse(error);
    }

    console.log(JSON.stringify({
      level: "info",
      event: "request_complete",
      requestId,
      method: request.method,
      path: url.pathname,
      status: response.status,
      durationMs: Date.now() - startedAt,
    }));
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/api/health" && request.method === "GET") {
    return Response.json({ ok: true, service: "webmcp-card-table" });
  }
  if (url.pathname === "/api/rooms" && request.method === "POST") {
    assertSameOrigin(request, url);
    return createRoom(request, url, env);
  }

  const match = /^\/api\/rooms\/([^/]+)\/(redeem|view|actions|socket)$/.exec(url.pathname);
  if (match) {
    const roomId = assertRoomId(match[1]);
    const operation = match[2];
    if (operation === "redeem" && request.method === "POST") {
      assertSameOrigin(request, url);
      return redeemInvite(request, roomId, env);
    }
    if (operation === "view" && request.method === "GET") return getView(request, roomId, env);
    if (operation === "actions" && request.method === "POST") {
      assertSameOrigin(request, url);
      return performAction(request, roomId, env);
    }
    if (operation === "socket" && request.method === "GET") {
      return connectSocket(request, roomId, env);
    }
  }

  if (url.pathname.startsWith("/api/")) return Response.json({ error: "not_found" }, { status: 404 });
  return env.ASSETS.fetch(request);
}

async function createRoom(request: Request, url: URL, env: Env): Promise<Response> {
  const createRequest = parseCreateRoom(await readJson(request));
  const roomId = randomToken(18);
  const sessionToken = randomToken();
  const sessionHash = await hashToken(sessionToken);
  const inviteToken = createRequest.mode === "free_play" ? randomToken() : null;
  const inviteHash = inviteToken ? await hashToken(inviteToken) : null;
  const contract = createRequest.mode === "practice" ? PRACTICE_CONTRACT : createRequest.contract;
  const seatIds = createRequest.mode === "practice" ? (["human", "house"] as const) : (["host", "guest"] as const);
  const result = await roomStub(env, roomId).createRoom({
    roomId,
    contract,
    seatIds: [...seatIds],
    hostSessionHash: sessionHash,
    inviteHash,
    now: Date.now(),
  });
  const view = unwrap(result);
  const body = {
    roomId,
    mode: createRequest.mode,
    view,
    ...(inviteToken ? { inviteUrl: `${url.origin}/table/${roomId}#invite=${inviteToken}` } : {}),
  };
  return jsonWithCookie(body, roomId, sessionToken, 201);
}

async function redeemInvite(request: Request, roomId: string, env: Env): Promise<Response> {
  const object = await readJson(request);
  const inviteToken = assertInviteToken(isObject(object) ? object.inviteToken : undefined);
  const inviteHash = await hashToken(inviteToken);
  const sessionToken = randomToken();
  const sessionHash = await hashToken(sessionToken);
  const view = unwrap(await roomStub(env, roomId).redeemInvite(inviteHash, sessionHash, Date.now()));
  return jsonWithCookie({ roomId, view }, roomId, sessionToken, 200);
}

async function getView(request: Request, roomId: string, env: Env): Promise<Response> {
  const sessionHash = await sessionHashFromRequest(request);
  return Response.json(unwrap(await roomStub(env, roomId).getView(sessionHash)));
}

async function performAction(request: Request, roomId: string, env: Env): Promise<Response> {
  const sessionHash = await sessionHashFromRequest(request);
  const envelope = parseActionEnvelope(await readJson(request));
  return Response.json(unwrap(await roomStub(env, roomId).performAction(sessionHash, envelope, Date.now())));
}

async function connectSocket(request: Request, roomId: string, env: Env): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new RequestError("upgrade_required", "A WebSocket upgrade is required", 426);
  }
  const sessionHash = await sessionHashFromRequest(request);
  const internalRequest = new Request("https://room.internal/socket", {
    headers: { upgrade: "websocket", "x-session-hash": sessionHash },
  });
  return roomStub(env, roomId).fetch(internalRequest);
}

function roomStub(env: Env, roomId: string): DurableObjectStub<GameRoom> {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomId));
}

function unwrap<T>(result: RpcResult<T>): T {
  if (result.ok) return result.value;
  throw new RequestError(result.error.code, result.error.message, result.error.status);
}

async function sessionHashFromRequest(request: Request): Promise<string> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const token = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!token) throw new RequestError("unauthorized", "A valid seat session is required", 401);
  return hashToken(token);
}

function jsonWithCookie(body: { view: TableView } & Record<string, unknown>, roomId: string, sessionToken: string, status: number): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${sessionToken}; Path=/api/rooms/${roomId}; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
  );
  return new Response(JSON.stringify(body), { status, headers });
}

function assertSameOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) throw new RequestError("cross_origin", "Cross-origin requests are not allowed", 403);
}

function errorResponse(error: unknown): Response {
  if (error instanceof RequestError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ level: "error", event: "request_failure", error: error instanceof Error ? error.message : "unknown" }));
  return Response.json({ error: "internal_error", message: "The request could not be completed" }, { status: 500 });
}

function withSecurityHeaders(response: Response): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("content-security-policy", "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
