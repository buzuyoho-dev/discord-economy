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

export function formatMode2Close(bet: { id: number; creatorId: string; title: string }): string {
  return [
    `🔒 **[모드2 마감]** 베팅 #${bet.id}`,
    `개최자: <@${bet.creatorId}>`,
    timestampLine(),
    `제목: ${bet.title}`,
    '※ 더 이상 참가 불가, 결과 대기 중',
  ].join('\n');
}

export function formatAdminGrant(targetId: string, amount: number, reason: string): string {
  return `💰 **[관리자 지급]** <@${targetId}> +${amount.toLocaleString()} (사유: ${reason})`;
}

interface SettlementCancellationPlan {
  mode: 1 | 2;
  betId: number;
  title: string;
  corrections: { userId: string; amount: number }[];
  houseDelta: number;
}

function formatHouseDeltaLine(houseDelta: number, prefix: string): string | null {
  if (houseDelta === 0) {
    return null;
  }
  const sign = houseDelta > 0 ? '+' : '';
  return `${prefix}: ${sign}${houseDelta.toLocaleString()}P`;
}

export function formatSettlementCancelPreview(plan: SettlementCancellationPlan): string {
  const totalOffset = plan.corrections.reduce((sum, c) => sum + Math.abs(c.amount), 0);

  return [
    `⚠️ **[정산취소 확인]** 베팅#${plan.betId} (${plan.title})`,
    `모드: ${plan.mode === 1 ? '모드1' : '모드2'}`,
    `되돌릴 참가자: ${plan.corrections.length}명`,
    `총 상쇄 금액: ${totalOffset.toLocaleString()}P`,
    formatHouseDeltaLine(plan.houseDelta, '하우스 반영') ?? '하우스 반영: 없음',
    '',
    '아래 버튼으로 최종 확인해주세요. 확인 시 참가자 잔액과 베팅 상태가 즉시 되돌아갑니다.',
  ].join('\n');
}

export function formatSettlementCancelLog(plan: SettlementCancellationPlan, adminId: string): string {
  const lines = plan.corrections.map((correction) => {
    const sign = correction.amount >= 0 ? '+' : '';
    return `- <@${correction.userId}>: ${sign}${correction.amount.toLocaleString()}P`;
  });
  const houseLine = formatHouseDeltaLine(plan.houseDelta, '하우스');

  return [
    `🔧 정산 취소: 베팅#${plan.betId} (관리자: <@${adminId}>), 사유: 정산 오류 정정`,
    `베팅 제목: ${plan.title}`,
    '조정 내역:',
    ...(lines.length > 0 ? lines : ['(대상자 없음)']),
    ...(houseLine ? [houseLine] : []),
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
