function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function timestampLine(): string {
  return `시각: <t:${unixSeconds(new Date())}:F>`;
}

export function formatMode1Create(bet: {
  id: number;
  creatorId: string;
  title: string;
  amount: number;
  options: { label: string }[];
}): string {
  return [
    `📋 **[모드1 개설]** 베팅 #${bet.id}`,
    `개최자: <@${bet.creatorId}>`,
    timestampLine(),
    `제목: ${bet.title}`,
    `금액: ${bet.amount.toLocaleString()} 포인트 (전원 동일)`,
    `옵션: ${bet.options.map((option) => option.label).join(', ')}`,
  ].join('\n');
}

export function formatMode1Join(bet: { id: number; title: string }, userId: string): string {
  return [
    `✅ **[모드1 참가]** 베팅 #${bet.id} (${bet.title})`,
    `참가자: <@${userId}>`,
    timestampLine(),
    '(선택 내용은 비공개 원칙에 따라 정산 시 함께 공개됩니다)',
  ].join('\n');
}

export function formatMode1Close(bet: { id: number; creatorId: string; title: string }): string {
  return [
    `🔒 **[모드1 마감]** 베팅 #${bet.id}`,
    `개최자: <@${bet.creatorId}>`,
    timestampLine(),
    `제목: ${bet.title}`,
    '※ 더 이상 참가 불가, 결과 대기 중',
  ].join('\n');
}

export function formatMode1Settle(
  settled: {
    id: number;
    status: string;
    title: string;
    creatorId: string;
    entryResults: { userId: string; optionId: number; creditedAmount: number }[];
  },
  options: { id: number; label: string }[],
  winningOptionId: number
): string {
  const optionLabel = (id: number) => options.find((option) => option.id === id)?.label ?? `옵션#${id}`;

  const lines = settled.entryResults.map((entry) => {
    const label = optionLabel(entry.optionId);
    if (settled.status === 'VOID') {
      return `- <@${entry.userId}>: ${label} (환불 +${entry.creditedAmount.toLocaleString()})`;
    }
    return entry.creditedAmount > 0
      ? `- <@${entry.userId}>: ${label} ✅ (+${entry.creditedAmount.toLocaleString()})`
      : `- <@${entry.userId}>: ${label} ❌`;
  });

  const header =
    settled.status === 'VOID'
      ? `🚫 **[모드1 정산 - 무효]** 베팅 #${settled.id} (${settled.title})`
      : `🏆 **[모드1 정산 - 완료]** 베팅 #${settled.id} (${settled.title})`;

  return [
    header,
    `개최자: <@${settled.creatorId}>`,
    timestampLine(),
    settled.status === 'VOID'
      ? '사유: 전원 동일 선택 또는 정답자 없음 → 전원 환불'
      : `정답: ${optionLabel(winningOptionId)}`,
    '참가자 및 결과:',
    ...(lines.length > 0 ? lines : ['(참가자 없음)']),
  ].join('\n');
}

export function formatMode2Create(bet: {
  id: number;
  creatorId: string;
  title: string;
  sideALabel: string;
  sideBLabel: string;
}): string {
  return [
    `📋 **[모드2 개설]** 베팅 #${bet.id}`,
    `개최자: <@${bet.creatorId}>`,
    timestampLine(),
    `제목: ${bet.title}`,
    `사이드: ${bet.sideALabel} / ${bet.sideBLabel} (자유 금액)`,
  ].join('\n');
}

export function formatMode2Join(bet: { id: number; title: string }, userId: string, amount: number): string {
  return [
    `✅ **[모드2 참가]** 베팅 #${bet.id} (${bet.title})`,
    `참가자: <@${userId}>`,
    timestampLine(),
    `베팅액: ${amount.toLocaleString()} 포인트`,
    '(선택한 사이드는 비공개 원칙에 따라 정산 시 함께 공개됩니다)',
  ].join('\n');
}

export function formatMode2Close(bet: { id: number; creatorId: string; title: string }): string {
  return [
    `🔒 **[모드2 마감]** 베팅 #${bet.id}`,
    `개최자: <@${bet.creatorId}>`,
    timestampLine(),
    `제목: ${bet.title}`,
    '※ 더 이상 참가 불가, 결과 대기 중',
  ].join('\n');
}

export function formatGamble(userId: string, result: { won: boolean; amount: number }): string {
  const outcome = result.won ? '승' : '패';
  const sign = result.amount >= 0 ? '+' : '';
  return `🎲 **[도박]** <@${userId}> ${outcome} (${sign}${result.amount.toLocaleString()})`;
}

export function formatMode2Settle(
  settled: {
    id: number;
    title: string;
    creatorId: string;
    entryResults: { userId: string; side: 'A' | 'B'; stake: number; creditedAmount: number }[];
  },
  sideALabel: string,
  sideBLabel: string,
  winningSide: 'A' | 'B'
): string {
  const sideLabel = (side: 'A' | 'B') => (side === 'A' ? sideALabel : sideBLabel);

  const lines = settled.entryResults.map((entry) => {
    const label = sideLabel(entry.side);
    return entry.creditedAmount > 0
      ? `- <@${entry.userId}>: ${label} (베팅 ${entry.stake.toLocaleString()}) ✅ (+${entry.creditedAmount.toLocaleString()})`
      : `- <@${entry.userId}>: ${label} (베팅 ${entry.stake.toLocaleString()}) ❌`;
  });

  return [
    `🏆 **[모드2 정산 - 완료]** 베팅 #${settled.id} (${settled.title})`,
    `개최자: <@${settled.creatorId}>`,
    timestampLine(),
    `정답: ${sideLabel(winningSide)}`,
    '참가자 및 결과:',
    ...(lines.length > 0 ? lines : ['(참가자 없음)']),
  ].join('\n');
}
