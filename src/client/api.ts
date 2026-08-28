import type { ActionEnvelope, GameContract, TableView } from "../shared";

export interface CreatedRoom {
  roomId: string;
  mode: "practice" | "free_play";
  view: TableView;
  inviteUrl?: string;
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export function createPracticeRoom(signal?: AbortSignal): Promise<CreatedRoom> {
  return requestJson("/api/rooms", { method: "POST", body: JSON.stringify({ mode: "practice" }), signal });
}

export function createFreePlayRoom(contract: GameContract, signal?: AbortSignal): Promise<CreatedRoom> {
  return requestJson("/api/rooms", { method: "POST", body: JSON.stringify({ mode: "free_play", contract }), signal });
}

export function redeemInvite(roomId: string, inviteToken: string, signal?: AbortSignal): Promise<{ view: TableView }> {
  return requestJson(`/api/rooms/${roomId}/redeem`, {
    method: "POST",
    body: JSON.stringify({ inviteToken }),
    signal,
  });
}

export function fetchTable(roomId: string, signal?: AbortSignal): Promise<TableView> {
  return requestJson(`/api/rooms/${roomId}/view`, { signal });
}

export function submitTableAction(roomId: string, envelope: ActionEnvelope, signal?: AbortSignal): Promise<TableView> {
  return requestJson(`/api/rooms/${roomId}/actions`, {
    method: "POST",
    body: JSON.stringify(envelope),
    signal,
  });
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const body = (await response.json()) as T | { error?: string; message?: string };
  if (!response.ok) {
    const error = body as { error?: string; message?: string };
    throw new ApiError(error.error ?? "request_failed", error.message ?? "The request could not be completed", response.status);
  }
  return body as T;
}

