import type { CardView, PublicCardView, Suit } from "../shared";

interface CardProps {
  card?: CardView | PublicCardView;
  selected?: boolean;
  compact?: boolean;
  onClick?: () => void;
}

const SUIT_MARKS: Record<Suit, string> = {
  clubs: "♣",
  diamonds: "♦",
  hearts: "♥",
  spades: "♠",
};

export function PlayingCard({ card, selected = false, compact = false, onClick }: CardProps) {
  const visibleCard = isVisibleCard(card) ? card : null;
  const hidden = !visibleCard;
  const className = `playing-card${hidden ? " card-back" : ""}${selected ? " selected" : ""}${compact ? " compact" : ""}`;
  const content = hidden ? (
    <span className="card-back-mark" aria-hidden="true">CT</span>
  ) : visibleCard ? (
    <>
      <span className={`card-corner ${isRed(visibleCard.suit) ? "red" : ""}`}>
        <strong>{visibleCard.rank}</strong>
        <span>{SUIT_MARKS[visibleCard.suit]}</span>
      </span>
      <span className={`card-suit ${isRed(visibleCard.suit) ? "red" : ""}`} aria-hidden="true">{SUIT_MARKS[visibleCard.suit]}</span>
    </>
  ) : null;
  const label = visibleCard ? `${visibleCard.rank} of ${visibleCard.suit}` : "Face-down card";

  if (onClick) {
    return <button type="button" className={className} aria-pressed={selected} aria-label={label} onClick={onClick}>{content}</button>;
  }
  return <div className={className} aria-label={label}>{content}</div>;
}

function isVisibleCard(card: CardView | PublicCardView | undefined): card is CardView | Extract<PublicCardView, { face: "up" }> {
  if (!card) return false;
  return !("face" in card) || card.face === "up";
}

function isRed(suit: Suit): boolean {
  return suit === "diamonds" || suit === "hearts";
}
