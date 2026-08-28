import type { SeatId, TableEvent, TableView } from "../shared";
import { motionForEvent } from "./motion";

interface CardSnapshot {
  clone: HTMLElement;
  rect: DOMRect;
  cardId?: string;
}

export interface PendingTableTransition {
  revision: number;
  sourceZoneKey: string;
  targetZoneKey: string;
  cards: CardSnapshot[];
  event: TableEvent;
}

export function publicZoneKey(ownerSeatId: SeatId | null, zoneId: string): string {
  return `public:${ownerSeatId ?? "shared"}:${zoneId}`;
}

export function seatZoneKey(seatId: SeatId, zoneId: string): string {
  return `seat:${seatId}:${zoneId}`;
}

export function captureTableTransition(nextView: TableView, root: HTMLElement | null): PendingTableTransition | null {
  if (!root || reducedMotion()) return null;
  const event = nextView.recentEvents.find((candidate) => candidate.revision === nextView.revision);
  if (!event) return null;
  const motion = motionForEvent(event, nextView);
  if (!motion) return null;

  if (motion.type === "play") {
    const sourceZoneId = stringValue(event.data.sourceZoneId) ?? "hand";
    const sourceZoneKey = seatZoneKey(motion.actorSeatId, sourceZoneId);
    const sourceZone = findZone(root, sourceZoneKey);
    const selectedCardIds = event.type === "cards_moved" && Array.isArray(event.data.cardIds)
      ? event.data.cardIds.filter((cardId): cardId is string => typeof cardId === "string")
      : [];
    const sourceCards = selectedCardIds.length > 0
      ? selectedCardIds.map((cardId) => findCard(sourceZone, cardId)).filter((card): card is HTMLElement => card !== null)
      : [lastCard(sourceZone)].filter((card): card is HTMLElement => card !== null);
    if (sourceCards.length === 0) return null;
    return {
      revision: nextView.revision,
      sourceZoneKey,
      targetZoneKey: publicZoneKey(motion.targetSeatId, motion.targetZoneId),
      cards: sourceCards.map(snapshot),
      event,
    };
  }

  const sourceZoneKey = publicZoneKey(motion.sourceSeatId, motion.sourceZoneId);
  const sourceZone = findZone(root, sourceZoneKey);
  const cards = sourceZone ? [...sourceZone.querySelectorAll<HTMLElement>("[data-card-visual]")].map(snapshot) : [];
  if (cards.length === 0) return null;
  return {
    revision: nextView.revision,
    sourceZoneKey,
    targetZoneKey: seatZoneKey(motion.actorSeatId, stringValue(event.data.targetZoneId) ?? "deck"),
    cards,
    event,
  };
}

export function playTableTransition(transition: PendingTableTransition, view: TableView, root: HTMLElement | null): void {
  if (!root || reducedMotion()) return;
  const motion = motionForEvent(transition.event, view);
  const targetZone = findZone(root, transition.targetZoneKey);
  if (!motion || !targetZone) return;

  if (motion.type === "play") {
    transition.cards.forEach((card, index) => {
      const destination = findCard(targetZone, card.cardId ?? motion.cardId);
      if (destination) moveDestinationCard(destination, card.rect, motion.face === "up", index);
    });
    return;
  }

  const targetCard = motion.placement === "bottom" ? firstCard(targetZone) : lastCard(targetZone);
  const targetRect = targetCard?.getBoundingClientRect() ?? targetZone.getBoundingClientRect();
  const destinationCover = motion.placement === "bottom" ? coverDestinationCards(targetZone, transition.cards.length) : [];
  const movements = transition.cards.map((card, index) => moveCollectedCard(card, targetRect, index, transition.cards.length));
  void Promise.all(movements).finally(() => destinationCover.forEach((card) => card.remove()));
}

function moveDestinationCard(destination: HTMLElement, sourceRect: DOMRect, flip: boolean, index: number): void {
  const destinationRect = destination.getBoundingClientRect();
  const deltaX = sourceRect.left - destinationRect.left;
  const deltaY = sourceRect.top - destinationRect.top;
  const scaleX = sourceRect.width / Math.max(destinationRect.width, 1);
  const scaleY = sourceRect.height / Math.max(destinationRect.height, 1);
  destination.animate([
    { transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY}) rotate(0deg)`, offset: 0 },
    { transform: `translate(${deltaX * .08}px, ${deltaY * .08}px) scale(1.015) rotate(${deltaX > 0 ? "-1deg" : "1deg"})`, offset: .82 },
    { transform: "translate(0, 0) scale(1) rotate(0deg)", offset: 1 },
  ], { duration: 620, delay: index * 55, easing: "cubic-bezier(.2,.72,.18,1)", fill: "both" });
  if (flip) {
    destination.querySelector<HTMLElement>(".card-rotator")?.animate([
      { transform: "rotateY(180deg)", offset: 0 },
      { transform: "rotateY(180deg)", offset: .48 },
      { transform: "rotateY(0deg)", offset: 1 },
    ], { duration: 620, delay: index * 55, easing: "cubic-bezier(.22,.65,.2,1)", fill: "both" });
  }
}

function moveCollectedCard(card: CardSnapshot, targetRect: DOMRect, index: number, count: number): Promise<void> {
  const clone = card.clone;
  clone.classList.add("table-transition-card");
  clone.setAttribute("aria-hidden", "true");
  clone.removeAttribute("role");
  clone.removeAttribute("aria-label");
  Object.assign(clone.style, {
    position: "fixed",
    zIndex: String(1000 + index),
    left: `${card.rect.left}px`,
    top: `${card.rect.top}px`,
    width: `${card.rect.width}px`,
    height: `${card.rect.height}px`,
    margin: "0",
    pointerEvents: "none",
  });
  document.body.append(clone);
  const fanOffset = (index - (count - 1) / 2) * 3;
  const deltaX = targetRect.left - card.rect.left + fanOffset;
  const deltaY = targetRect.top - card.rect.top - index * 2;
  const scaleX = targetRect.width / Math.max(card.rect.width, 1);
  const scaleY = targetRect.height / Math.max(card.rect.height, 1);
  const duration = 540 + index * 55;
  const movement = clone.animate([
    { transform: "translate(0, 0) scale(1) rotate(0deg)" },
    { transform: `translate(${deltaX * .88}px, ${deltaY * .76}px) scale(${scaleX * 1.03}, ${scaleY * 1.03}) rotate(${fanOffset}deg)`, offset: .78 },
    { transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY}) rotate(0deg)` },
  ], { duration, delay: index * 38, easing: "cubic-bezier(.28,.02,.16,1)", fill: "both" });
  const rotator = clone.querySelector<HTMLElement>(".card-rotator");
  if (rotator && !clone.classList.contains("card-back")) {
    rotator.animate([
      { transform: "rotateY(0deg)", offset: 0 },
      { transform: "rotateY(0deg)", offset: .42 },
      { transform: "rotateY(180deg)", offset: .82 },
      { transform: "rotateY(180deg)", offset: 1 },
    ], { duration, delay: index * 38, easing: "cubic-bezier(.24,.62,.2,1)", fill: "both" });
  }
  return movement.finished.then(() => undefined, () => undefined).finally(() => clone.remove());
}

function coverDestinationCards(targetZone: HTMLElement, movingCardCount: number): HTMLElement[] {
  return [...targetZone.querySelectorAll<HTMLElement>("[data-card-visual]")].map((card, index) => {
    const rect = card.getBoundingClientRect();
    const cover = card.cloneNode(true) as HTMLElement;
    cover.classList.add("table-transition-cover-card");
    cover.setAttribute("aria-hidden", "true");
    cover.removeAttribute("role");
    cover.removeAttribute("aria-label");
    Object.assign(cover.style, {
      position: "fixed",
      zIndex: String(1000 + movingCardCount + index + 1),
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
      pointerEvents: "none",
    });
    document.body.append(cover);
    return cover;
  });
}

function snapshot(card: HTMLElement): CardSnapshot {
  return { clone: card.cloneNode(true) as HTMLElement, rect: card.getBoundingClientRect(), ...(card.dataset.cardId ? { cardId: card.dataset.cardId } : {}) };
}

function findZone(root: HTMLElement, key: string): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>("[data-zone-key]")].find((zone) => zone.dataset.zoneKey === key) ?? null;
}

function findCard(zone: HTMLElement | null, cardId: string): HTMLElement | null {
  if (!zone) return null;
  return [...zone.querySelectorAll<HTMLElement>("[data-card-id]")].find((card) => card.dataset.cardId === cardId) ?? null;
}

function lastCard(zone: HTMLElement | null): HTMLElement | null {
  return [...(zone?.querySelectorAll<HTMLElement>("[data-card-visual]") ?? [])].at(-1) ?? null;
}

function firstCard(zone: HTMLElement | null): HTMLElement | null {
  return zone?.querySelector<HTMLElement>("[data-card-visual]") ?? null;
}

function stringValue(value: TableEvent["data"][string]): string | null {
  return typeof value === "string" ? value : null;
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
