import type { CardView, PublicCardView, Suit } from "../shared";

interface CardProps {
  card?: CardView | PublicCardView;
  selected?: boolean;
  onClick?: () => void;
}

const SUIT_MARKS: Record<Suit, string> = {
  clubs: "♣",
  diamonds: "♦",
  hearts: "♥",
  spades: "♠",
};

export function PlayingCard({ card, selected = false, onClick }: CardProps) {
  const visibleCard = isVisibleCard(card) ? card : null;
  const hidden = !visibleCard;
  const className = `playing-card${hidden ? " card-back" : ""}${selected ? " selected" : ""}`;
  const front = visibleCard ? (
    <span className="card-side card-front" aria-hidden="true">
      <span className={`card-corner ${isRed(visibleCard.suit) ? "red" : ""}`}>
        <strong>{visibleCard.rank}</strong>
        <span>{SUIT_MARKS[visibleCard.suit]}</span>
      </span>
      <span className={`card-suit ${isRed(visibleCard.suit) ? "red" : ""}`} aria-hidden="true">{SUIT_MARKS[visibleCard.suit]}</span>
    </span>
  ) : <span className="card-side card-front" aria-hidden="true" />;
  const content = (
    <span className="card-rotator">
      {front}
      <span className="card-side card-reverse" aria-hidden="true"><span className="card-back-mark">CT</span></span>
    </span>
  );
  const label = visibleCard ? `${visibleCard.rank} of ${visibleCard.suit}` : "Face-down card";
  const data = { "data-card-visual": "", ...(card?.id ? { "data-card-id": card.id } : {}) };

  if (onClick) {
    return <button type="button" className={className} aria-pressed={selected} aria-label={label} onClick={onClick} {...data}>{content}</button>;
  }
  return <div className={className} role="img" aria-label={label} {...data}>{content}</div>;
}

function isVisibleCard(card: CardView | PublicCardView | undefined): card is CardView | Extract<PublicCardView, { face: "up" }> {
  if (!card) return false;
  return !("face" in card) || card.face === "up";
}

function isRed(suit: Suit): boolean {
  return suit === "diamonds" || suit === "hearts";
}
