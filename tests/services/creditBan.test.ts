import { describe, expect, test } from 'vitest';
import { isCreditBanned } from '../../src/services/creditBan';
import { getOrCreateHouse } from '../../src/services/house';
import { getOrCreateUser } from '../../src/services/ledger';
import { acceptLoan, repayLoan, requestLoan } from '../../src/services/loan';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// requestLoan -> acceptLoan을 한 번에 실행해 즉시 ACTIVE 상태 대출을 만드는 테스트 헬퍼.
// now를 request/accept 양쪽에 동일하게 넘기면 dueAt = now + dueDays(기본 7일)가 된다.
async function createActiveLoanFixture(params: {
  lenderId: string;
  borrowerId: string;
  principal: number;
  now?: Date;
}) {
  const requested = await requestLoan({
    lenderId: params.lenderId,
    borrowerId: params.borrowerId,
    principal: params.principal,
    now: params.now,
  });
  return acceptLoan({ loanId: requested.id, acceptedBy: params.borrowerId, now: params.now });
}

describe('isCreditBanned', () => {
  test('대출이 없는 유저는 신용불량이 아니다', async () => {
    await getOrCreateUser('clean-user');
    expect(await isCreditBanned('clean-user')).toBe(false);
  });

  test('상환일이 11일 지난 대출이 있으면 신용불량이다', async () => {
    await getOrCreateUser('lender-cb-1');
    await getOrCreateUser('borrower-cb-1');
    await getOrCreateHouse();

    const createdAt = new Date('2026-06-01T00:00:00.000Z');
    const loan = await createActiveLoanFixture({
      lenderId: 'lender-cb-1',
      borrowerId: 'borrower-cb-1',
      principal: 1_000_000,
      now: createdAt,
    });

    const elevenDaysLate = new Date(loan.dueAt!.getTime() + 11 * ONE_DAY_MS);
    expect(await isCreditBanned('borrower-cb-1', elevenDaysLate)).toBe(true);
  });

  test('신용불량 구간 시작 전(10일 연체 이내)에는 아직 신용불량이 아니다', async () => {
    await getOrCreateUser('lender-cb-2');
    await getOrCreateUser('borrower-cb-2');
    await getOrCreateHouse();

    const loan = await createActiveLoanFixture({
      lenderId: 'lender-cb-2',
      borrowerId: 'borrower-cb-2',
      principal: 1_000_000,
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    const nineDaysLate = new Date(loan.dueAt!.getTime() + 9 * ONE_DAY_MS);
    expect(await isCreditBanned('borrower-cb-2', nineDaysLate)).toBe(false);
  });

  test('신용불량 구간(시작~끝) 중에는 true, 구간이 끝나면 다시 false가 된다', async () => {
    await getOrCreateUser('lender-cb-3');
    await getOrCreateUser('borrower-cb-3');
    await getOrCreateHouse();

    const loan = await createActiveLoanFixture({
      lenderId: 'lender-cb-3',
      borrowerId: 'borrower-cb-3',
      principal: 1_000_000,
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    const banStart = new Date(loan.dueAt!.getTime() + 10 * ONE_DAY_MS);
    const banEnd = new Date(banStart.getTime() + 7 * ONE_DAY_MS);

    expect(await isCreditBanned('borrower-cb-3', banStart)).toBe(true); // 구간 시작 시점
    expect(await isCreditBanned('borrower-cb-3', new Date(banEnd.getTime() - 1))).toBe(true); // 구간 끝나기 직전
    expect(await isCreditBanned('borrower-cb-3', banEnd)).toBe(false); // 구간 종료 시점 - 다시 허용
    expect(await isCreditBanned('borrower-cb-3', new Date(banEnd.getTime() + ONE_DAY_MS))).toBe(false);
  });

  test('이미 상환된 대출이라도, 한때 10일 넘게 연체했었다면 그 7일 구간 안에서는 여전히 신용불량이다', async () => {
    await getOrCreateUser('lender-cb-4');
    await getOrCreateUser('borrower-cb-4');
    await getOrCreateHouse();

    const loan = await createActiveLoanFixture({
      lenderId: 'lender-cb-4',
      borrowerId: 'borrower-cb-4',
      principal: 1_000_000,
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    // 12일 연체된 시점에 뒤늦게 상환 (이자 포함)
    const repaidAt = new Date(loan.dueAt!.getTime() + 12 * ONE_DAY_MS);
    await repayLoan({ loanId: loan.id, repaidBy: 'borrower-cb-4', now: repaidAt });

    // 상환을 마친 뒤에도, 신용불량 구간(상환일+10일 ~ +17일) 안이면 여전히 true여야 한다
    const stillWithinBanWindow = new Date(loan.dueAt!.getTime() + 13 * ONE_DAY_MS);
    expect(await isCreditBanned('borrower-cb-4', stillWithinBanWindow)).toBe(true);

    // 구간을 완전히 벗어나면 false
    const afterBanWindow = new Date(loan.dueAt!.getTime() + 18 * ONE_DAY_MS);
    expect(await isCreditBanned('borrower-cb-4', afterBanWindow)).toBe(false);
  });
});
