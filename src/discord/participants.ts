export function formatParticipantsLine(participantUserIds: string[]): string {
  if (participantUserIds.length === 0) {
    return '참가자 (0명): 없음';
  }

  const mentions = participantUserIds.map((userId) => `<@${userId}>`).join(' ');
  return `참가자 (${participantUserIds.length}명): ${mentions}`;
}
