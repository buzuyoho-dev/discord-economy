export class BetNotFoundError extends Error {}
export class BetNotOpenError extends Error {}
export class BetNotClosedError extends Error {}
export class AlreadyJoinedError extends Error {}
export class NotBetCreatorError extends Error {}
export class InvalidBetOptionsError extends Error {}

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, '');
}
