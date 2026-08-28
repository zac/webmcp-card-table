import { useEffect, useState } from "react";
import type { TableView } from "../shared";
import type { CreatedRoom } from "./api";
import { Lobby } from "./Lobby";
import { TablePage } from "./TablePage";

interface Route {
  roomId?: string;
  initialView?: TableView;
  inviteUrl?: string;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => routeFromLocation());

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function openRoom(room: CreatedRoom) {
    window.history.pushState({ inviteUrl: room.inviteUrl }, "", `/table/${room.roomId}`);
    setRoute({ roomId: room.roomId, initialView: room.view, inviteUrl: room.inviteUrl });
  }

  function goHome() {
    window.history.pushState({}, "", "/");
    setRoute({});
  }

  return route.roomId
    ? <TablePage roomId={route.roomId} initialView={route.initialView} inviteUrl={route.inviteUrl} onHome={goHome} />
    : <Lobby onRoomCreated={openRoom} />;
}

function routeFromLocation(): Route {
  const match = /^\/table\/([A-Za-z0-9_-]{16,80})$/.exec(window.location.pathname);
  const state = window.history.state as { inviteUrl?: string } | null;
  return match ? { roomId: match[1], inviteUrl: state?.inviteUrl } : {};
}
