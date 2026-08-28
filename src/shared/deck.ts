import { RANKS, SUITS, type Card, type RandomSource } from "./types";

export function createDeck(idFactory: () => string): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ id: idFactory(), rank, suit })));
}

export function shuffleCards<T>(cards: readonly T[], random: RandomSource): T[] {
  const shuffled = [...cards];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = random.nextInt(index + 1);
    if (swapIndex < 0 || swapIndex > index || !Number.isInteger(swapIndex)) {
      throw new Error("Random source returned an out-of-range index");
    }
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

export function countCards(state: {
  seats: readonly { hand: readonly Card[] }[];
  zones: readonly { cards: readonly { card: Card }[] }[];
}): number {
  const seatCards = state.seats.reduce((total, seat) => total + seat.hand.length, 0);
  return seatCards + state.zones.reduce((total, zone) => total + zone.cards.length, 0);
}
