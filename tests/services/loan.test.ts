import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { CreditBannedError } from '../../src/services/creditBan';
import { BotTargetError } from '../../src/services/discordTargetGuard';
import { getOrCreateHouse, HOUSE_ID } from '../../src/services/house';
import { getOrCreateUser, InsufficientBalanceError } from '../../src/services/ledger';
import {
  acceptLoan,
  calculateInterest,
  calculateOverdueDays,
  CannotLoanToSelfError,
  declineLoan,
  DEFAULT_DUE_DAYS,
  getUserLoans,
  InvalidDueDaysError,
  InvalidLoanAmountError,
  LoanAmountTooLargeError,
  LoanNotActiveError,
  LoanNotFoundError,
  LoanNotPendingError,
  LoanRequestExpiredError,
  MAX_LOAN_AMOUNT,
  NotBorrowerError,
  repayLoan,
  requestLoan,
} from '../../src/services/loan';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// 매번 requestLoan -> acceptLoan 두 단계를 거치는 반복을 줄이기 위한 테스트 전용 헬퍼.
// 기존 createLoan(즉시 실행)과 동일한 결과(ACTIVE, dueAt = now + dueDays)를 만들어낸다.
async function createActiveLoanFixture(params: {
  lenderId: string;
  borrowerId: string;
  principal: number;
  now?: Date;
  dueDays?: number;
}) {
  const requested = await requestLoan({
    lenderId: params.lenderId,
    borrowerId: params.borrowerId,
    principal: params.principal,
    dueDays: params.dueDays,
    now: params.now,
  });
  return acceptLoan({ loanId: requested.id, acceptedBy: params.borrowerId, now: params.now });
}

describe('calculateOverdueDays', () => {
  test('상환일 전이면 0일이다', () => {
    const dueAt = new Date('2026-07-01T00:00:00.000Z');
    const now = new Date('2026-06-30T00:00:00.000Z');
    expect(calculateOverdueDays(dueAt, now)).toBe(0);
  });

  test('상환일로부터 N일 지나면 N일로 계산된다', () => {
    const dueAt = new Date('2026-07-01T00:00:00.000Z');
    const now = new Date('2026-07-04T00:00:00.000Z');
    expect(calculateOverdueDays(dueAt, now)).toBe(3);
  });

  test('10일을 초과해도 최대 10일로 캡된다', () => {
    const dueAt = new Date('2026-07-01T00:00:00.000Z');
    const now = new Date('2026-07-20T00:00:00.000Z');
    expect(calculateOverdueDays(dueAt, now)).toBe(10);
  });
});

describe('calculateInterest', () => {
  test('단리로 원금의 5% x 연체일수, 내림 처리한다', () => {
    expect(calculateInterest(1_000_000, 3)).toBe(150_000);
    expect(calculateInterest(1_000_001, 3)).toBe(Math.floor(1_000_001 * 0.05 * 3));
  });

  test('연체일수 0이면 이자 0이다', () => {
    expect(calculateInterest(1_000_000, 0)).toBe(0);
  });
});

describe('Loan 스키마: PENDING/DECLINED 확장', () => {
  test('PENDING 상태로 dueAt 없이, dueDays만 지정해서 대출 요청 레코드를 생성할 수 있다', async () => {
    await getOrCreateUser('lender-pending-1');
    await getOrCreateUser('borrower-pending-1');

    const loan = await prisma.loan.create({
      data: {
        lenderId: 'lender-pending-1',
        borrowerId: 'borrower-pending-1',
        principal: 1_000_000,
        status: 'PENDING',
        dueDays: 7,
      },
    });

    expect(loan.status).toBe('PENDING');
    expect(loan.dueAt).toBeNull();
    expect(loan.dueDays).toBe(7);
  });

  test('PENDING 대출 요청을 DECLINED로 변경할 수 있다', async () => {
    await getOrCreateUser('lender-declined-1');
    await getOrCreateUser('borrower-declined-1');

    const loan = await prisma.loan.create({
      data: {
        lenderId: 'lender-declined-1',
        borrowerId: 'borrower-declined-1',
        principal: 500_000,
        status: 'PENDING',
        dueDays: 7,
      },
    });

    const declined = await prisma.loan.update({
      where: { id: loan.id },
      data: { status: 'DECLINED' },
    });

    expect(declined.status).toBe('DECLINED');
  });
});

describe('requestLoan', () => {
  test('정상 요청: PENDING 상태로만 생성되고 lender/borrower/house 잔액은 전혀 변하지 않는다', async () => {
    await getOrCreateUser('lender-req-1');
    await getOrCreateUser('borrower-req-1');
    await getOrCreateHouse();

    const loan = await requestLoan({
      lenderId: 'lender-req-1',
      borrowerId: 'borrower-req-1',
      principal: 1_000_000,
      dueDays: 10,
    });

    expect(loan.status).toBe('PENDING');
    expect(loan.principal).toBe(1_000_000);
    expect(loan.dueDays).toBe(10);
    expect(loan.dueAt).toBeNull();

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-req-1' } });
    const borrower = await prisma.user.findUniqueOrThrow({ where: { discordId: 'borrower-req-1' } });
    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });

    expect(lender.balance).toBe(10_000_000);
    expect(borrower.balance).toBe(10_000_000);
    expect(house.balance).toBe(0);
  });

  test('상환일수를 지정하지 않으면 기본 7일로 저장된다', async () => {
    await getOrCreateUser('lender-req-2');
    await getOrCreateUser('borrower-req-2');

    const loan = await requestLoan({
      lenderId: 'lender-req-2',
      borrowerId: 'borrower-req-2',
      principal: 1_000_000,
    });

    expect(loan.dueDays).toBe(DEFAULT_DUE_DAYS);
  });

  test('3,000만 포인트를 초과하면 거부되고 레코드도 생성되지 않는다', async () => {
    await getOrCreateUser('lender-req-3');
    await getOrCreateUser('borrower-req-3');

    await expect(
      requestLoan({ lenderId: 'lender-req-3', borrowerId: 'borrower-req-3', principal: MAX_LOAN_AMOUNT + 1 })
    ).rejects.toThrow(LoanAmountTooLargeError);

    const loans = await prisma.loan.findMany({ where: { lenderId: 'lender-req-3' } });
    expect(loans).toHaveLength(0);
  });

  test('본인에게 요청하면 거부된다', async () => {
    await getOrCreateUser('lender-req-4');

    await expect(
      requestLoan({ lenderId: 'lender-req-4', borrowerId: 'lender-req-4', principal: 1_000 })
    ).rejects.toThrow(CannotLoanToSelfError);
  });

  test('빌릴 사람이 봇이면 거부된다', async () => {
    await getOrCreateUser('lender-req-5');

    await expect(
      requestLoan({
        lenderId: 'lender-req-5',
        borrowerId: 'bot-req-5',
        borrowerIsBot: true,
        principal: 1_000_000,
      })
    ).rejects.toThrow(BotTargetError);
  });

  test.each([NaN, -5, 0, 1.5, Infinity])('금액이 %s이면 거부된다', async (principal) => {
    await getOrCreateUser('lender-req-6');
    await getOrCreateUser('borrower-req-6');

    await expect(
      requestLoan({ lenderId: 'lender-req-6', borrowerId: 'borrower-req-6', principal })
    ).rejects.toThrow(InvalidLoanAmountError);
  });

  test.each([0, -1, 1.5, NaN, Infinity])('상환일수가 %s이면 거부된다', async (dueDays) => {
    await getOrCreateUser('lender-req-7');
    await getOrCreateUser('borrower-req-7');

    await expect(
      requestLoan({ lenderId: 'lender-req-7', borrowerId: 'borrower-req-7', principal: 1_000_000, dueDays })
    ).rejects.toThrow(InvalidDueDaysError);
  });

  test('차입자가 신용불량 상태면 요청 자체가 거부된다', async () => {
    await getOrCreateUser('lender-req-8');
    await getOrCreateUser('borrower-req-8');
    await getOrCreateUser('other-lender-req-8');
    await getOrCreateHouse();

    const oldLoan = await createActiveLoanFixture({
      lenderId: 'lender-req-8',
      borrowerId: 'borrower-req-8',
      principal: 1_000_000,
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    const elevenDaysLate = new Date(oldLoan.dueAt!.getTime() + 11 * ONE_DAY_MS);

    await expect(
      requestLoan({
        lenderId: 'other-lender-req-8',
        borrowerId: 'borrower-req-8',
        principal: 500_000,
        now: elevenDaysLate,
      })
    ).rejects.toThrow(CreditBannedError);
  });
});

describe('acceptLoan', () => {
  test('정상 수락: PENDING -> ACTIVE로 바뀌고 dueAt은 수락 시각+dueDays, 잔액이 이체된다', async () => {
    await getOrCreateUser('lender-acc-1');
    await getOrCreateUser('borrower-acc-1');
    await getOrCreateHouse();

    const requestedAt = new Date('2026-07-01T00:00:00.000Z');
    const requested = await requestLoan({
      lenderId: 'lender-acc-1',
      borrowerId: 'borrower-acc-1',
      principal: 1_000_000,
      dueDays: 10,
      now: requestedAt,
    });

    const acceptedAt = new Date('2026-07-01T01:00:00.000Z'); // 요청 1시간 뒤에 수락 (24시간 만료 전)
    const loan = await acceptLoan({ loanId: requested.id, acceptedBy: 'borrower-acc-1', now: acceptedAt });

    expect(loan.status).toBe('ACTIVE');
    expect(loan.dueAt?.getTime()).toBe(acceptedAt.getTime() + 10 * ONE_DAY_MS); // 요청 시각이 아니라 수락 시각 기준

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-acc-1' } });
    const borrower = await prisma.user.findUniqueOrThrow({ where: { discordId: 'borrower-acc-1' } });
    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });

    expect(lender.balance).toBe(10_000_000 - 1_000_000);
    expect(borrower.balance).toBe(10_000_000 + 1_000_000 - 20_000); // 2% 수수료 제외
    expect(house.balance).toBe(20_000);
  });

  test('borrower가 아닌 사람이 수락하면 거부되고 아무것도 바뀌지 않는다', async () => {
    await getOrCreateUser('lender-acc-2');
    await getOrCreateUser('borrower-acc-2');
    await getOrCreateHouse();

    const requested = await requestLoan({
      lenderId: 'lender-acc-2',
      borrowerId: 'borrower-acc-2',
      principal: 1_000_000,
    });

    await expect(acceptLoan({ loanId: requested.id, acceptedBy: 'someone-else' })).rejects.toThrow(
      NotBorrowerError
    );

    const loanAfter = await prisma.loan.findUniqueOrThrow({ where: { id: requested.id } });
    expect(loanAfter.status).toBe('PENDING');
  });

  test('존재하지 않는 대출을 수락하려 하면 거부된다', async () => {
    await expect(acceptLoan({ loanId: 999_999, acceptedBy: 'nobody' })).rejects.toThrow(LoanNotFoundError);
  });

  test('PENDING이 아닌(이미 처리된) 요청을 다시 수락하면 거부된다', async () => {
    await getOrCreateUser('lender-acc-3');
    await getOrCreateUser('borrower-acc-3');
    await getOrCreateHouse();

    const requested = await requestLoan({
      lenderId: 'lender-acc-3',
      borrowerId: 'borrower-acc-3',
      principal: 1_000_000,
    });
    await acceptLoan({ loanId: requested.id, acceptedBy: 'borrower-acc-3' });

    await expect(acceptLoan({ loanId: requested.id, acceptedBy: 'borrower-acc-3' })).rejects.toThrow(
      LoanNotPendingError
    );
  });

  test('요청 후 24시간이 지나면 수락이 거부되고 잔액도 변하지 않는다', async () => {
    await getOrCreateUser('lender-acc-4');
    await getOrCreateUser('borrower-acc-4');
    await getOrCreateHouse();

    const requestedAt = new Date('2026-07-01T00:00:00.000Z');
    const requested = await requestLoan({
      lenderId: 'lender-acc-4',
      borrowerId: 'borrower-acc-4',
      principal: 1_000_000,
      now: requestedAt,
    });

    const justAfter24h = new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000);

    await expect(
      acceptLoan({ loanId: requested.id, acceptedBy: 'borrower-acc-4', now: justAfter24h })
    ).rejects.toThrow(LoanRequestExpiredError);

    const loanAfter = await prisma.loan.findUniqueOrThrow({ where: { id: requested.id } });
    expect(loanAfter.status).toBe('PENDING');

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-acc-4' } });
    expect(lender.balance).toBe(10_000_000);
  });

  test('23시간 59분처럼 24시간 직전이면 아직 수락할 수 있다', async () => {
    await getOrCreateUser('lender-acc-5');
    await getOrCreateUser('borrower-acc-5');
    await getOrCreateHouse();

    const requestedAt = new Date('2026-07-01T00:00:00.000Z');
    const requested = await requestLoan({
      lenderId: 'lender-acc-5',
      borrowerId: 'borrower-acc-5',
      principal: 1_000_000,
      now: requestedAt,
    });

    const justBefore24h = new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000 - 1);

    const loan = await acceptLoan({
      loanId: requested.id,
      acceptedBy: 'borrower-acc-5',
      now: justBefore24h,
    });
    expect(loan.status).toBe('ACTIVE');
  });

  test('동시에 두 번 수락 시도해도 처리는 정확히 한 번만 일어난다', async () => {
    await getOrCreateUser('lender-acc-6');
    await getOrCreateUser('borrower-acc-6');
    await getOrCreateHouse();

    const requested = await requestLoan({
      lenderId: 'lender-acc-6',
      borrowerId: 'borrower-acc-6',
      principal: 1_000_000,
    });

    const results = await Promise.allSettled([
      acceptLoan({ loanId: requested.id, acceptedBy: 'borrower-acc-6' }),
      acceptLoan({ loanId: requested.id, acceptedBy: 'borrower-acc-6' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LoanNotPendingError);

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-acc-6' } });
    // 두 번 이체됐다면 9,000,000이 됨 - 정상은 한 번만 이체되어 9,000,000이 아니라 딱 한 번만 차감
    expect(lender.balance).toBe(10_000_000 - 1_000_000);
  });

  test('lender 잔액이 부족하면 InsufficientBalanceError로 거부되고 대출은 PENDING으로 유지된다', async () => {
    await getOrCreateUser('lender-acc-7');
    await getOrCreateUser('borrower-acc-7');
    await getOrCreateHouse();

    const requested = await requestLoan({
      lenderId: 'lender-acc-7',
      borrowerId: 'borrower-acc-7',
      principal: 1_000_000,
    });

    // 요청 이후 lender가 다른 곳에 다 써버려서 잔액이 부족해진 상황을 시뮬레이션한다.
    await prisma.user.update({ where: { discordId: 'lender-acc-7' }, data: { balance: 500_000 } });

    await expect(acceptLoan({ loanId: requested.id, acceptedBy: 'borrower-acc-7' })).rejects.toThrow(
      InsufficientBalanceError
    );

    const loanAfter = await prisma.loan.findUniqueOrThrow({ where: { id: requested.id } });
    expect(loanAfter.status).toBe('PENDING');

    const borrower = await prisma.user.findUniqueOrThrow({ where: { discordId: 'borrower-acc-7' } });
    expect(borrower.balance).toBe(10_000_000); // 변경 없음
  });
});

describe('declineLoan', () => {
  test('정상 거절: status가 DECLINED로 바뀌고 잔액은 전혀 변하지 않는다', async () => {
    await getOrCreateUser('lender-dec-1');
    await getOrCreateUser('borrower-dec-1');

    const requested = await requestLoan({
      lenderId: 'lender-dec-1',
      borrowerId: 'borrower-dec-1',
      principal: 1_000_000,
    });

    const loan = await declineLoan({ loanId: requested.id, declinedBy: 'borrower-dec-1' });
    expect(loan.status).toBe('DECLINED');

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-dec-1' } });
    const borrower = await prisma.user.findUniqueOrThrow({ where: { discordId: 'borrower-dec-1' } });
    expect(lender.balance).toBe(10_000_000);
    expect(borrower.balance).toBe(10_000_000);
  });

  test('borrower가 아닌 사람이 거절하면 거부된다', async () => {
    await getOrCreateUser('lender-dec-2');
    await getOrCreateUser('borrower-dec-2');

    const requested = await requestLoan({
      lenderId: 'lender-dec-2',
      borrowerId: 'borrower-dec-2',
      principal: 1_000_000,
    });

    await expect(declineLoan({ loanId: requested.id, declinedBy: 'someone-else' })).rejects.toThrow(
      NotBorrowerError
    );
  });

  test('존재하지 않는 대출을 거절하려 하면 거부된다', async () => {
    await expect(declineLoan({ loanId: 999_999, declinedBy: 'nobody' })).rejects.toThrow(
      LoanNotFoundError
    );
  });

  test('PENDING이 아닌(이미 처리된) 요청을 다시 거절하면 거부된다', async () => {
    await getOrCreateUser('lender-dec-3');
    await getOrCreateUser('borrower-dec-3');

    const requested = await requestLoan({
      lenderId: 'lender-dec-3',
      borrowerId: 'borrower-dec-3',
      principal: 1_000_000,
    });
    await declineLoan({ loanId: requested.id, declinedBy: 'borrower-dec-3' });

    await expect(declineLoan({ loanId: requested.id, declinedBy: 'borrower-dec-3' })).rejects.toThrow(
      LoanNotPendingError
    );
  });
});

describe('getUserLoans', () => {
  test('lenderId로 요청한 대출과 borrowerId로 요청받은 대출을 분리해서, 각각 최신순으로 반환한다', async () => {
    await getOrCreateUser('multi-1');
    await getOrCreateUser('multi-2');
    await getOrCreateUser('multi-3');

    const t0 = new Date('2026-07-01T00:00:00.000Z');
    const t1 = new Date('2026-07-02T00:00:00.000Z');

    // multi-1이 lender인 요청
    const lentOlder = await requestLoan({
      lenderId: 'multi-1',
      borrowerId: 'multi-2',
      principal: 100_000,
      now: t0,
    });
    const lentNewer = await requestLoan({
      lenderId: 'multi-1',
      borrowerId: 'multi-3',
      principal: 200_000,
      now: t1,
    });

    // multi-1이 borrower인 요청
    const borrowed = await requestLoan({
      lenderId: 'multi-2',
      borrowerId: 'multi-1',
      principal: 300_000,
      now: t0,
    });

    const { asLender, asBorrower } = await getUserLoans('multi-1');

    expect(asLender.map((l) => l.id)).toEqual([lentNewer.id, lentOlder.id]); // 최신순
    expect(asBorrower.map((l) => l.id)).toEqual([borrowed.id]);
  });

  test('관련 대출이 없으면 양쪽 다 빈 배열이다', async () => {
    await getOrCreateUser('no-loans-1');

    const { asLender, asBorrower } = await getUserLoans('no-loans-1');
    expect(asLender).toEqual([]);
    expect(asBorrower).toEqual([]);
  });
});

describe('repayLoan', () => {
  test('상환일 전에 상환하면 이자 없이 원금만 전달된다', async () => {
    await getOrCreateUser('lender-6');
    await getOrCreateUser('borrower-6');
    await getOrCreateHouse();

    const createdAt = new Date('2026-06-21T00:00:00.000Z');
    const loan = await createActiveLoanFixture({
      lenderId: 'lender-6',
      borrowerId: 'borrower-6',
      principal: 1_000_000,
      now: createdAt,
    });

    const repaidAt = new Date('2026-06-25T00:00:00.000Z'); // 상환일(7일 후) 전
    const result = await repayLoan({ loanId: loan.id, repaidBy: 'borrower-6', now: repaidAt });

    expect(result.interest).toBe(0);
    expect(result.totalRepaid).toBe(1_000_000);
    expect(result.loan.status).toBe('REPAID');

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-6' } });
    // 대출 실행 시 -1,000,000, 상환 수령 시 +1,000,000 => 원래 잔액으로 복귀
    expect(lender.balance).toBe(10_000_000);
  });

  test('상환일이 지나면 연체일수 x 5% 단리 이자가 함께 청구된다', async () => {
    await getOrCreateUser('lender-7');
    await getOrCreateUser('borrower-7');
    await getOrCreateHouse();

    const createdAt = new Date('2026-06-21T00:00:00.000Z');
    const loan = await createActiveLoanFixture({
      lenderId: 'lender-7',
      borrowerId: 'borrower-7',
      principal: 1_000_000,
      now: createdAt,
    }); // dueAt = 2026-06-28

    const repaidAt = new Date('2026-07-01T00:00:00.000Z'); // 3일 연체
    const result = await repayLoan({ loanId: loan.id, repaidBy: 'borrower-7', now: repaidAt });

    expect(result.interest).toBe(150_000); // 1,000,000 * 0.05 * 3
    expect(result.totalRepaid).toBe(1_150_000);

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-7' } });
    // -1,000,000(대출) + 1,150,000(상환+이자) = +150,000
    expect(lender.balance).toBe(10_000_000 + 150_000);

    const borrower = await prisma.user.findUniqueOrThrow({ where: { discordId: 'borrower-7' } });
    // +1,000,000-20,000(수수료) - 1,150,000(상환) = -170,000
    expect(borrower.balance).toBe(10_000_000 - 170_000);
  });

  test('10일을 초과한 연체도 이자는 10일치(원금의 50%)로 캡된다', async () => {
    await getOrCreateUser('lender-8');
    await getOrCreateUser('borrower-8');
    await getOrCreateHouse();

    const createdAt = new Date('2026-06-21T00:00:00.000Z');
    const loan = await createActiveLoanFixture({
      lenderId: 'lender-8',
      borrowerId: 'borrower-8',
      principal: 1_000_000,
      now: createdAt,
    }); // dueAt = 2026-06-28

    const repaidAt = new Date('2026-07-20T00:00:00.000Z'); // 22일 연체 (10일 초과)
    const result = await repayLoan({ loanId: loan.id, repaidBy: 'borrower-8', now: repaidAt });

    expect(result.interest).toBe(500_000); // 원금의 50%로 캡
    expect(result.totalRepaid).toBe(1_500_000);
  });

  test('이미 상환된 대출을 다시 상환하면 거부된다', async () => {
    await getOrCreateUser('lender-9');
    await getOrCreateUser('borrower-9');
    await getOrCreateHouse();

    const loan = await createActiveLoanFixture({ lenderId: 'lender-9', borrowerId: 'borrower-9', principal: 1_000_000 });
    await repayLoan({ loanId: loan.id, repaidBy: 'borrower-9' });

    await expect(repayLoan({ loanId: loan.id, repaidBy: 'borrower-9' })).rejects.toThrow(
      LoanNotActiveError
    );
  });

  test('차입자가 아닌 사람이 상환을 시도하면 거부된다', async () => {
    await getOrCreateUser('lender-10');
    await getOrCreateUser('borrower-10');
    await getOrCreateHouse();

    const loan = await createActiveLoanFixture({
      lenderId: 'lender-10',
      borrowerId: 'borrower-10',
      principal: 1_000_000,
    });

    await expect(repayLoan({ loanId: loan.id, repaidBy: 'someone-else' })).rejects.toThrow(
      NotBorrowerError
    );
  });

  test('존재하지 않는 대출을 상환하려 하면 거부된다', async () => {
    await expect(repayLoan({ loanId: 999_999, repaidBy: 'nobody' })).rejects.toThrow(
      LoanNotFoundError
    );
  });

  test('동시에 같은 대출을 두 번 상환 시도해도 처리는 정확히 한 번만 일어난다', async () => {
    await getOrCreateUser('lender-11');
    await getOrCreateUser('borrower-11');
    await getOrCreateHouse();

    const loan = await createActiveLoanFixture({
      lenderId: 'lender-11',
      borrowerId: 'borrower-11',
      principal: 1_000_000,
    });

    const results = await Promise.allSettled([
      repayLoan({ loanId: loan.id, repaidBy: 'borrower-11' }),
      repayLoan({ loanId: loan.id, repaidBy: 'borrower-11' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LoanNotActiveError);

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-11' } });
    // 상환이 두 번 일어났다면 1,000,000을 두 번 받아 11,000,000이 됨 - 정상은 한 번만 받아 10,000,000
    expect(lender.balance).toBe(10_000_000);
  });

  test('차입자 잔액이 상환액(원금+이자)보다 적으면 InsufficientBalanceError로 거부되고 대출은 ACTIVE로 유지된다', async () => {
    await getOrCreateUser('lender-12');
    await getOrCreateUser('borrower-12');
    await getOrCreateHouse();

    const loan = await createActiveLoanFixture({
      lenderId: 'lender-12',
      borrowerId: 'borrower-12',
      principal: 1_000_000,
    });

    // 대출 수령 후 차입자가 다 써버려서 상환액보다 잔액이 부족한 상황을 시뮬레이션한다.
    await prisma.user.update({ where: { discordId: 'borrower-12' }, data: { balance: 500_000 } });

    await expect(repayLoan({ loanId: loan.id, repaidBy: 'borrower-12' })).rejects.toThrow(
      InsufficientBalanceError
    );

    const loanAfter = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(loanAfter.status).toBe('ACTIVE'); // 부분 처리된 채로 남지 않음

    const borrower = await prisma.user.findUniqueOrThrow({ where: { discordId: 'borrower-12' } });
    expect(borrower.balance).toBe(500_000); // 변경 없음

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-12' } });
    // 차입자 차감이 실패했으므로 대출자에게 상환금이 지급되지도 않아야 함
    expect(lender.balance).toBe(10_000_000 - 1_000_000);
  });
});
