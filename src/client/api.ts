import type { ActionEnvelope, GameContract, RoomReplay, SeatId, TableView } from "../shared";

const SEAT_STORAGE_PREFIX = "card-table-seat:";

export interface CreatedRoom {
  roomId: string;
  view: TableView;
  inviteUrl: string;
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function createRoom(contract: GameContract, signal?: AbortSignal): Promise<CreatedRoom> {
  const room = await requestJson<CreatedRoom>("/api/rooms", { method: "POST", body: JSON.stringify({ contract }), signal });
  rememberSeat(room.roomId, "host");
  return room;
}

export async function redeemInvite(roomId: string, inviteToken: string, signal?: AbortSignal): Promise<{ view: TableView }> {
  const result = await requestJson<{ view: TableView }>(`/api/rooms/${roomId}/redeem`, {
    method: "POST",
    body: JSON.stringify({ inviteToken }),
    signal,
  });
  rememberSeat(roomId, "guest");
  return result;
}

export function fetchTable(roomId: string, signal?: AbortSignal): Promise<TableView> {
  return requestJson(`/api/rooms/${roomId}/view`, { signal }, roomId);
}

export function fetchTableReplay(roomId: string, revision?: number, signal?: AbortSignal): Promise<RoomReplay> {
  const query = revision === undefined ? "" : `?revision=${revision}`;
  return requestJson(`/api/rooms/${roomId}/replay${query}`, { signal }, roomId);
}

export function submitTableAction(roomId: string, envelope: ActionEnvelope, signal?: AbortSignal): Promise<TableView> {
  return requestJson(`/api/rooms/${roomId}/actions`, {
    method: "POST",
    body: JSON.stringify(envelope),
    signal,
  }, roomId);
}

export function rememberSeat(roomId: string, seatId: SeatId): void {
  if (typeof window !== "undefined") window.sessionStorage.setItem(`${SEAT_STORAGE_PREFIX}${roomId}`, seatId);
}

export function seatForRoom(roomId: string): SeatId | null {
  if (typeof window === "undefined") return null;
  const value = window.sessionStorage.getItem(`${SEAT_STORAGE_PREFIX}${roomId}`);
  return value === "host" || value === "guest" ? value : null;
}

async function requestJson<T>(path: string, init: RequestInit, roomId?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  const seatId = roomId ? seatForRoom(roomId) : null;
  if (seatId) headers.set("x-card-table-seat", seatId);
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const body = (await response.json()) as T | { error?: string; message?: string };
  if (!response.ok) {
    const error = body as { error?: string; message?: string };
    throw new ApiError(error.error ?? "request_failed", error.message ?? "The request could not be completed", response.status);
  }
  return body as T;
}
